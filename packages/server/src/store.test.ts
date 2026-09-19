import { expect, test } from "bun:test";
import { chainHash } from "@remote-tab/protocol/src/crypto";
import { createApp } from "./app";
import { MemoryStore } from "./memory-store";
import { RateLimited, SessionNotActive, type Store } from "./store";
import { append, sessionRecord, storeContract } from "./store-contract";

storeContract("MemoryStore shared contract", async (now) => {
  const store = new MemoryStore(now);
  return { a: store, b: store, close: async () => {} };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const state of ["stopped", "expired"] as const)
  test(`MemoryStore ${state} during hashing prevents publication`, async () => {
    const now = new Date();
    const store = new MemoryStore(() => now);
    const record = sessionRecord(now);
    await store.createSession(record);
    const entered = deferred();
    const release = deferred();
    const pending = store.appendMessage(
      record.id,
      { role: "agent", prevHash: "", nonce: "n", ciphertext: "c" },
      async (seq) => {
        entered.resolve();
        await release.promise;
        return chainHash(record.id, seq, "c");
      },
    );
    await entered.promise;
    await store.updateSession(record.id, (current) => ({ ...current, state }));
    release.resolve();
    await expect(pending).rejects.toBeInstanceOf(SessionNotActive);
    expect(await store.listMessages(record.id, 0, 20)).toEqual([]);
    expect(await store.getSession(record.id)).toMatchObject({ state, lastSeq: 0 });
  });

test("MemoryStore rechecks cap after a competing append finishes hashing", async () => {
  const now = new Date();
  const store = new MemoryStore(() => now);
  const record = sessionRecord(now);
  await store.createSession(record);
  const entered = deferred();
  const release = deferred();
  const pending = store.appendMessage(
    record.id,
    { role: "agent", prevHash: "", nonce: "n", ciphertext: "c" },
    async () => {
      entered.resolve();
      await release.promise;
      return "loser";
    },
    1,
  );
  await entered.promise;
  await append(store, record.id, "winner", "", 1);
  release.resolve();
  await expect(pending).rejects.toBeInstanceOf(RateLimited);
  expect(await store.listMessages(record.id, 0, 20)).toHaveLength(1);
});

test("MemoryStore Extend rearms waiting expiry and cleanup survives cancellation", async () => {
  let time = Date.now();
  const store = new MemoryStore(() => new Date(time));
  const record = sessionRecord(new Date(time), { expiresAt: new Date(time + 40).toISOString() });
  await store.createSession(record);
  let finished = false;
  const waiting = store.waitForMessage(record.id, 0, 2000).then(() => {
    finished = true;
  });
  await store.updateSession(record.id, (current) => ({
    ...current,
    expiresAt: new Date(time + 1000).toISOString(),
  }));
  time += 40;
  await Bun.sleep(80);
  expect(finished).toBe(false);
  await append(store, record.id);
  await waiting;
  const controller = new AbortController();
  const canceled = store.waitForMessage(record.id, 1, 2000, controller.signal);
  controller.abort();
  await canceled;
  expect((store as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(0);
});

test("HTTP duplicate and terminal replay preserve credentials and do not consume another slot", async () => {
  const now = new Date();
  const store = new MemoryStore(() => now);
  const record = sessionRecord(now);
  const app = createApp({
    store,
    anonymousQps: 10000,
    now: () => now,
    limits: { activeMax: 1, activePerIp: 1 },
  });
  const create = (id = record.id) =>
    app.fetch(
      new Request("http://test/v1/sessions", { method: "POST", body: JSON.stringify({ id }) }),
    );
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const winner = responses.find((r) => r.status === 201);
  if (!winner) throw new Error("Missing successful create");
  const session = await winner.json();
  const before = await store.getSession(record.id);
  expect((await create()).status).toBe(409);
  expect(await store.getSession(record.id)).toEqual(before);
  const stopped = await app.fetch(
    new Request(`http://test/v1/sessions/${record.id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
    }),
  );
  expect(stopped.status).toBe(200);
  const terminal = await store.getSession(record.id);
  expect((await (await create()).json()).error).toBe("id_taken");
  expect(await store.getSession(record.id)).toEqual(terminal);
  expect((await create("f".repeat(32))).status).toBe(201);
});

test("HTTP append reports a concurrent stop as session_not_active", async () => {
  class StoppingStore extends MemoryStore {
    override appendMessage(...[id, message, hashFor]: Parameters<Store["appendMessage"]>) {
      return super.appendMessage(id, message, async (seq) => {
        await this.updateSession(id, (current) => ({ ...current, state: "stopped" }));
        return hashFor(seq);
      });
    }
  }
  const store = new StoppingStore();
  const app = createApp({ store, anonymousQps: 10000 });
  const created = await app.fetch(
    new Request("http://test/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ id: "a".repeat(32) }),
    }),
  );
  const { id, agent_token } = await created.json();
  await app.fetch(new Request(`http://test/v1/sessions/${id}/redeem`, { method: "POST" }));
  const response = await app.fetch(
    new Request(`http://test/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent_token}` },
      body: JSON.stringify({
        role: "agent",
        prev_hash: "",
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "Y2lwaGVydGV4dC1ieXRlcy1oZXJl",
      }),
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "session_not_active" });
  expect(await store.getSession(id)).toMatchObject({ state: "stopped", lastSeq: 0 });
});
