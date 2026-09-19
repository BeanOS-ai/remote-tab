import { expect, test } from "bun:test";
import type { Envelope, WireMessage } from "@remote-tab/protocol";
import {
  b64url,
  chainHash,
  deriveSessionId,
  deriveSessionKey,
  messageAad,
  randomSecret,
  seal,
  sealBytes,
} from "@remote-tab/protocol/src/crypto";
import { Peer } from "./peer";
import type { BlobReference, Fetch, Ledger } from "./types";

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const metadataBytes = (ledger: Ledger) =>
  jsonBytes(ledger.status) +
  ledger.entries.reduce((n, entry) => n + jsonBytes({ ...entry, attachments: [] }), 0);
async function fixture(repetitions = 4) {
  const secret = randomSecret();
  const sessionId = await deriveSessionId(secret);
  const key = await deriveSessionKey(secret, sessionId);
  const messages: WireMessage[] = [];
  async function append(envelope: Envelope) {
    const seq = messages.length + 1;
    const prev_hash = messages.at(-1)?.hash ?? "";
    const encrypted = await seal(key, envelope, messageAad(sessionId, "browser", prev_hash));
    messages.push({
      seq,
      role: "browser",
      prev_hash,
      hash: await chainHash(sessionId, seq, encrypted.ciphertext),
      ...encrypted,
      created_at: "2026-09-18T00:00:00Z",
    });
  }
  await append({ v: 1, kind: "hello", id: "hello", body: { mode: "act", scope: null } });
  const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const sealed = await sealBytes(
    key,
    plaintext,
    messageAad(sessionId, "browser", messages[0].hash),
  );
  const reference: BlobReference = {
    blob_id: "b".repeat(32),
    nonce: b64url(sealed.nonce),
    role: "browser",
    prev_hash: messages[0].hash,
    mime_type: "image/png",
  };
  await append({
    v: 1,
    kind: "result",
    id: "result",
    body: { ok: true, blobs: Array.from({ length: repetitions }, () => reference) },
  });
  const status = {
    id: sessionId,
    state: "stopped",
    expires_at: "2026-10-01T00:00:00Z",
    last_seq: messages.length,
    last_hash: messages.at(-1)?.hash,
    redeemed: true,
  };
  const counts = { messages: 0, blobs: 0, pulled: 0, canceled: 0, concurrent: 0, maxConcurrent: 0 };
  const settings: { contentLength: boolean; blockBlob?: number; hugeMetadata?: boolean } = {
    contentLength: true,
  };
  const fetch: Fetch = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/messages")) {
      counts.messages++;
      if (settings.hugeMetadata)
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                counts.pulled += 32;
                controller.enqueue(new Uint8Array(32).fill(32));
              },
              cancel() {
                counts.canceled++;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      return Response.json({ messages, state: "stopped" });
    }
    if (!path.includes("/blobs/")) return Response.json(status);
    counts.blobs++;
    counts.concurrent++;
    counts.maxConcurrent = Math.max(counts.maxConcurrent, counts.concurrent);
    const index = counts.blobs;
    let offset = 0;
    return new Response(
      new ReadableStream(
        {
          async pull(controller) {
            if (settings.blockBlob === index) return;
            await Bun.sleep(1);
            const next = sealed.ciphertext.slice(offset, offset + 8);
            counts.pulled += next.length;
            offset += next.length;
            controller.enqueue(next);
            if (offset === sealed.ciphertext.length) {
              counts.concurrent--;
              controller.close();
            }
          },
          cancel() {
            counts.canceled++;
            counts.concurrent--;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: settings.contentLength
          ? { "content-length": String(sealed.ciphertext.length) }
          : {},
      },
    );
  };
  const peer = new Peer("https://ledger.test", sessionId, "test-token", secret, "browser", {
    fetch,
    requestTimeoutMs: 1000,
  });
  return {
    peer,
    counts,
    settings,
    plaintext,
    reset: () => {
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
  };
}

test("entry cap rejects status before fetching message pages or any attachment", async () => {
  const p = await fixture();
  await expect(p.peer.ledger({ maxEntries: 1 })).rejects.toMatchObject({
    code: "ledger_too_large",
  });
  expect(p.counts.messages).toBe(0);
  expect(p.counts.blobs).toBe(0);
});

test("exact metadata plus plaintext budget succeeds and repeated references each consume memory", async () => {
  const p = await fixture();
  const baseline = await p.peer.ledger();
  const bytes = metadataBytes(baseline) + 4 * p.plaintext.length;
  p.reset();
  const bounded = await p.peer.ledger({ maxEntries: 2, maxBytes: bytes });
  expect(bounded).toEqual(baseline);
  expect(p.counts.maxConcurrent).toBe(1);
  expect(p.counts.blobs).toBe(4);
  bounded.entries[1].attachments[0].bytes.fill(255);
  expect(bounded.entries[1].attachments[1].bytes).toEqual(p.plaintext);
  expect((await p.peer.ledger()).entries[1].attachments[0].bytes).toEqual(p.plaintext);
});

test("cumulative budget stops before reading an oversized next body or requesting remaining repeated refs", async () => {
  const p = await fixture(20);
  const baseline = await p.peer.ledger();
  p.reset();
  await expect(
    p.peer.ledger({ maxBytes: metadataBytes(baseline) + 2 * p.plaintext.length }),
  ).rejects.toMatchObject({ code: "ledger_too_large" });
  expect(p.counts.blobs).toBe(3);
  expect(p.counts.pulled).toBe(2 * (p.plaintext.length + 16));
  expect(p.counts.canceled).toBe(1);
  expect(p.counts.maxConcurrent).toBe(1);
});

test("streamed bodies without Content-Length enforce remaining budget and cancel at overflow", async () => {
  const p = await fixture(20);
  const baseline = await p.peer.ledger();
  p.reset();
  p.settings.contentLength = false;
  await expect(
    p.peer.ledger({ maxBytes: metadataBytes(baseline) + p.plaintext.length - 1 }),
  ).rejects.toMatchObject({ code: "ledger_too_large" });
  expect(p.counts.blobs).toBe(1);
  expect(p.counts.pulled).toBe(p.plaintext.length + 16);
  expect(p.counts.maxConcurrent).toBe(1);
});

test("metadata has the same retrieval budget and oversized streaming pages are canceled", async () => {
  const p = await fixture();
  p.settings.hugeMetadata = true;
  await expect(p.peer.ledger({ maxBytes: 512 })).rejects.toMatchObject({
    code: "ledger_too_large",
  });
  expect(p.counts.pulled).toBeLessThan(1600);
  expect(p.counts.canceled).toBe(1);
  expect(p.counts.blobs).toBe(0);
});

test("aborting a blocked attachment cancels its stream and starts no later downloads", async () => {
  const p = await fixture(20);
  p.settings.blockBlob = 1;
  const controller = new AbortController();
  const pending = p.peer.ledger({ maxBytes: 100_000, signal: controller.signal });
  while (p.counts.blobs === 0) await Bun.sleep(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(p.counts.blobs).toBe(1);
  expect(p.counts.canceled).toBe(1);
});

test("invalid budgets fail before network traffic", async () => {
  const p = await fixture();
  for (const options of [
    { maxEntries: -1 },
    { maxEntries: 1.5 },
    { maxBytes: Number.POSITIVE_INFINITY },
    { maxBytes: Number.NaN },
  ])
    await expect(p.peer.ledger(options)).rejects.toMatchObject({ code: "invalid" });
  expect(p.counts.messages).toBe(0);
  expect(p.counts.blobs).toBe(0);
});
