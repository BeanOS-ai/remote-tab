import { expect, test } from "bun:test";
import type { SessionStatus, WireMessage } from "@remote-tab/protocol";
import { deriveSessionKey, messageAad, seal } from "@remote-tab/protocol/src/crypto";
import { createApp } from "../../server/src/app";
import { MemoryStore } from "../../server/src/memory-store";
import { AgentSession, BrowserPeer, type Fetch, createSession } from "./index";

type Filter = (request: Request, response: Response) => Promise<Response>;
const hello = { mode: "act" as const, scope: null, title: "Fake tab" };

async function peers() {
  const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["test", "test-key"]]) });
  let filter: Filter = async (_request, response) => response;
  const fetch: Fetch = async (request) => filter(request, await app.fetch(request));
  const options = {
    serverUrl: "http://remote-tab.test",
    fetch,
    pollIntervalMs: 0,
    timeoutMs: 2000,
  };
  const { code, session } = await createSession({ ...options, apiKey: "test-key" });
  const browser = await BrowserPeer.redeem({ ...options, code, hello });
  await session.waitReady();
  return {
    rawFetch: app.fetch,
    session,
    browser,
    options,
    setFilter: (next: Filter) => {
      filter = next;
    },
  };
}

async function roundTrip(p: Awaited<ReturnType<typeof peers>>, screenshot = false) {
  const result = p.session.send("browser_snapshot", {});
  const command = await p.browser.nextCommand();
  expect(command.kind).toBe("command");
  await p.browser.sendResult(
    command.id,
    { title: "Fake tab", refs: ["e1"] },
    screenshot
      ? {
          screenshot: {
            bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            mimeType: "image/png",
          },
        }
      : undefined,
  );
  return result;
}

for (const corruption of ["hash", "prev_hash", "seq"] as const) {
  test(`ledger rejects corrupted ${corruption}`, async () => {
    const p = await peers();
    p.setFilter(async (request, response) => {
      if (!new URL(request.url).pathname.endsWith("/messages") || request.method !== "GET")
        return response;
      const page = (await response.json()) as { messages: WireMessage[]; state: string };
      if (page.messages[0]) {
        if (corruption === "seq") page.messages[0].seq += 1;
        else page.messages[0][corruption] = "f".repeat(64);
      }
      return Response.json(page);
    });
    await expect(p.session.ledger()).rejects.toMatchObject({ code: "chain_invalid" });
  });
}

test("every fresh read rejects a chain gap before sending a command", async () => {
  const p = await peers();
  let commandPosts = 0;
  p.setFilter(async (request, response) => {
    if (new URL(request.url).pathname.endsWith("/messages")) {
      if (request.method === "POST") commandPosts += 1;
      else {
        const page = await response.json();
        page.messages = [];
        return Response.json(page);
      }
    }
    return response;
  });
  const resumed = AgentSession.resume(p.session.exportState(), p.options);
  await expect(resumed.send("browser_click", { ref: "e1" })).rejects.toMatchObject({
    code: "chain_invalid",
  });
  expect(commandPosts).toBe(0);
});

test("ledger exports one status-anchored snapshot while new messages arrive", async () => {
  const p = await peers();
  const state = p.session.exportState();
  let injected = false;
  p.setFilter(async (request, response) => {
    if (
      !injected &&
      request.method === "GET" &&
      new URL(request.url).pathname === `/v1/sessions/${state.sessionId}`
    ) {
      injected = true;
      const anchor = (await response.json()) as SessionStatus;
      const sealed = await seal(
        await deriveSessionKey(state.secret, state.sessionId),
        {
          v: 1,
          kind: "command",
          id: crypto.randomUUID(),
          body: { tool: "browser_snapshot", args: {} },
        },
        messageAad(state.sessionId, "agent", anchor.last_hash),
      );
      const appended = await p.rawFetch(
        new Request(`${state.serverUrl}/v1/sessions/${state.sessionId}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${state.agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ role: "agent", prev_hash: anchor.last_hash, ...sealed }),
        }),
      );
      expect(appended.status).toBe(201);
      return Response.json(anchor);
    }
    return response;
  });
  const ledger = await p.session.ledger();
  expect(ledger.status.last_seq).toBe(1);
  expect(ledger.entries).toHaveLength(ledger.status.last_seq);
  expect(ledger.entries.at(-1)?.message.hash).toBe(ledger.status.last_hash);
  expect((await p.session.status()).last_seq).toBe(2);
});

test("ledger refuses rollback behind a previously verified tail", async () => {
  const p = await peers();
  await roundTrip(p);
  const original = await p.session.ledger();
  const first = original.entries[0].message;
  p.setFilter(async (request, response) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return response;
    if (path.endsWith("/messages")) {
      const page = await response.json();
      page.messages = page.messages.filter((message: WireMessage) => message.seq <= 1);
      return Response.json(page);
    }
    if (path === `/v1/sessions/${p.session.sessionId}`) {
      const status = (await response.json()) as SessionStatus;
      return Response.json({ ...status, last_seq: 1, last_hash: first.hash });
    }
    return response;
  });
  await expect(p.session.ledger()).rejects.toMatchObject({ code: "chain_invalid" });
});

test("result and ledger both authenticate downloaded blob bytes", async () => {
  const p = await peers();
  p.setFilter(async (request, response) => {
    if (request.method === "GET" && new URL(request.url).pathname.includes("/blobs/")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      bytes[0] ^= 1;
      return new Response(bytes);
    }
    return response;
  });
  const result = p.session.send("browser_take_screenshot", {}).catch((error: unknown) => error);
  const command = await p.browser.nextCommand();
  await p.browser.sendResult(
    command.id,
    {},
    {
      screenshot: { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" },
    },
  );
  expect(await result).toMatchObject({ code: "decrypt_failed" });
  await expect(p.session.ledger()).rejects.toMatchObject({ code: "decrypt_failed" });
});

test("fresh ledger reads every page after the 200-message server boundary", async () => {
  const p = await peers();
  for (let i = 0; i < 102; i++) await roundTrip(p);
  await p.session.stop();
  const resumed = AgentSession.resume(p.session.exportState(), p.options);
  const ledger = await resumed.ledger();
  expect(ledger.entries).toHaveLength(206);
  expect(ledger.entries.map((entry) => entry.message.seq)).toEqual(
    Array.from({ length: 206 }, (_, i) => i + 1),
  );
  expect(ledger.entries.at(-1)?.envelope.kind).toBe("stop");
  expect(ledger.status.state).toBe("stopped");
}, 15000);
