import { expect, test } from "bun:test";
import { deriveSessionKey, messageAad, seal } from "@remote-tab/protocol/src/crypto";
import { createApp } from "../../server/src/app";
import { StaticKeyResolver } from "../../server/src/key-resolver";
import { MemoryStore } from "../../server/src/memory-store";
import { BrowserPeer, type Fetch, createSession } from "./index";

async function peers() {
  const app = createApp({
    store: new MemoryStore(),
    keyResolver: new StaticKeyResolver(new Map([["test", "test-key"]]), { defaultQps: 0 }),
    anonymousQps: 0,
  });
  let browserToken = "";
  let blobReads = 0;
  const fetch: Fetch = async (request) => {
    const response = await app.fetch(request);
    if (new URL(request.url).pathname.endsWith("/redeem")) {
      browserToken = (await response.clone().json()).browser_token;
    }
    if (request.method === "GET" && new URL(request.url).pathname.includes("/blobs/")) blobReads++;
    return response;
  };
  const options = {
    serverUrl: "http://remote-tab.test",
    fetch,
    pollWaitSeconds: 0,
    pollIntervalMs: 1,
    timeoutMs: 2000,
  };
  const { code, session } = await createSession({ ...options, apiKey: "test-key" });
  const browser = await BrowserPeer.redeem({
    ...options,
    code,
    hello: { mode: "full", scope: null },
  });
  const state = session.exportState();
  const rawResult = async (id: string, metadata: Record<string, unknown>) => {
    const status = await session.status();
    const encrypted = await seal(
      await deriveSessionKey(state.secret, state.sessionId),
      {
        v: 1,
        kind: "result",
        id,
        body: { ok: true, result: {}, ...metadata },
      },
      messageAad(state.sessionId, "browser", status.last_hash),
    );
    const response = await app.fetch(
      new Request(`${options.serverUrl}/v1/sessions/${state.sessionId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${browserToken}` },
        body: JSON.stringify({ role: "browser", prev_hash: status.last_hash, ...encrypted }),
      }),
    );
    expect(response.status).toBe(201);
  };
  return { session, browser, rawResult, blobReads: () => blobReads };
}

test("application blob_id fields in evaluate results and nested command args remain ordinary data", async () => {
  const p = await peers();
  const args = {
    function: "() => ({blob_id: 'application-record'})",
    context: {
      blob_id: "argument-record",
      screenshot: { blob_id: "argument-shot" },
      blobs: [{ blob_id: "argument-blob" }],
    },
  };
  const applicationResult = {
    blob_id: "application-record",
    nested: {
      screenshot: { blob_id: "application-shot" },
      blobs: [{ blob_id: "application-blob" }],
    },
  };
  const pending = p.session.send("browser_evaluate", args);
  const command = await p.browser.nextCommand();
  expect(command).toMatchObject({ kind: "command", args });
  await p.browser.sendResult(command.id, applicationResult);
  const result = await pending;
  expect(result.result).toEqual(applicationResult);
  expect(result.attachments).toEqual([]);
  const ledger = await p.session.ledger();
  expect(ledger.entries[1].envelope.body).toEqual({ tool: "browser_evaluate", args });
  expect(ledger.entries[2].envelope.body).toEqual({ ok: true, result: applicationResult });
  expect(ledger.entries.every((entry) => entry.attachments.length === 0)).toBe(true);
  expect(p.blobReads()).toBe(0);
});

test("reserved screenshot and blobs decrypt alongside application fields named blob_id", async () => {
  const p = await peers();
  const pending = p.session.send("browser_evaluate", {
    function: "() => ({blob_id: 'application-record'})",
  });
  const command = await p.browser.nextCommand();
  const screenshot = new Uint8Array([137, 80, 78, 71]);
  const snapshot = new TextEncoder().encode("snapshot");
  await p.browser.sendResult(
    command.id,
    { blob_id: "application-record" },
    {
      screenshot: { bytes: screenshot, mimeType: "image/png" },
      blobs: [{ bytes: snapshot, mimeType: "text/plain" }],
    },
  );
  const result = await pending;
  expect(result.result).toEqual({ blob_id: "application-record" });
  expect(result.attachments.map((attachment) => attachment.bytes)).toEqual([screenshot, snapshot]);
  const ledger = await p.session.ledger();
  expect(ledger.entries[2].attachments.map((attachment) => attachment.bytes)).toEqual([
    screenshot,
    snapshot,
  ]);
  expect(p.blobReads()).toBe(4);
});

for (const [label, metadata] of [
  ["null screenshot", { screenshot: null }],
  ["string screenshot", { screenshot: "application-record" }],
  ["missing reference fields", { screenshot: {} }],
  ["nested screenshot wrapper", { screenshot: { nested: { blob_id: "application-record" } } }],
  ["null blobs", { blobs: null }],
  ["non-array blobs", { blobs: {} }],
  ["null blob reference", { blobs: [null] }],
  ["malformed blob reference", { blobs: [{ blob_id: "application-record" }] }],
] as const) {
  test(`malformed reserved metadata fails for send and ledger: ${label}`, async () => {
    const p = await peers();
    const pending = p.session.send("browser_evaluate", {}).catch((error: unknown) => error);
    const command = await p.browser.nextCommand();
    await p.rawResult(command.id, metadata);
    expect(await pending).toMatchObject({ code: "protocol_invalid" });
    await expect(p.session.ledger()).rejects.toMatchObject({ code: "protocol_invalid" });
    expect(p.blobReads()).toBe(0);
  });
}
