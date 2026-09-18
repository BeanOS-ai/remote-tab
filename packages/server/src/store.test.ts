import { describe, expect, test } from "bun:test";
import { chainHash, verifyChain } from "@remote-tab/protocol/src/crypto";
import { createApp } from "./app";
import { GcsStore } from "./gcs-store";
import { MemoryStore } from "./memory-store";
import { ChainMismatch, SessionNotActive, type SessionRecord, type Store } from "./store";

const record: SessionRecord = {
  id: "test-session",
  platform: "test",
  state: "active",
  createdAt: "2026-09-18T00:00:00Z",
  expiresAt: "2026-09-18T00:30:00Z",
  redeemUntil: "2026-09-18T00:10:00Z",
  ttlSeconds: 1800,
  agentTokenHash: "agent",
  browserTokenHash: "browser",
  lastSeq: 0,
  lastHash: "",
};
const stateObject = `sessions/${record.id}/state.json`;
const input = { role: "agent" as const, prevHash: "", nonce: "nonce", ciphertext: "first" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Models durable objects, create-only writes and generation CAS across instances.
// Hooks delay/fail requests at the actual upload boundary, not inside the store.
function gcsHarness() {
  const objects = new Map<string, { body: string; generation: string }>();
  let generation = 0;
  const hooks: {
    before?: (name: string, request: Request) => Promise<Response | undefined>;
    after?: (name: string, request: Request) => Promise<Response | undefined>;
  } = {};
  const fetchFn = (async (url, init) => {
    const req = new Request(url, init);
    const parsed = new URL(req.url);
    const name =
      req.method === "POST"
        ? (parsed.searchParams.get("name") ?? "")
        : decodeURIComponent(parsed.pathname.split("/o/")[1]);
    const body = req.method === "POST" ? await req.clone().text() : "";
    const before = await hooks.before?.(name, req);
    if (before) return before;
    const current = objects.get(name);
    if (req.method === "GET") {
      return current
        ? new Response(current.body, { headers: { "x-goog-generation": current.generation } })
        : new Response(null, { status: 404 });
    }
    const match = parsed.searchParams.get("ifGenerationMatch");
    if ((match === "0" && current) || (match !== "0" && match !== current?.generation)) {
      return new Response(null, { status: 412 });
    }
    const next = { body, generation: String(++generation) };
    objects.set(name, next);
    const after = await hooks.after?.(name, req);
    return after ?? Response.json({ generation: next.generation });
  }) as typeof fetch;
  const makeStore = () =>
    new GcsStore({ bucket: "test", token: async () => "test", fetch: fetchFn });
  return { objects, hooks, makeStore };
}

async function append(store: Store, ciphertext = "first", prevHash = "") {
  return store.appendMessage(record.id, { ...input, ciphertext, prevHash }, (seq) =>
    chainHash(record.id, seq, ciphertext),
  );
}

for (const [name, makeStore] of [
  ["MemoryStore", () => new MemoryStore()],
  ["GcsStore", () => gcsHarness().makeStore()],
] as const) {
  describe(name, () => {
    test("overlapping appends commit one sequence and retain a verifiable chain", async () => {
      const store = makeStore();
      await store.createSession(record);
      const results = await Promise.allSettled([append(store, "one"), append(store, "two")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ChainMismatch);
      const messages = await store.listMessages(record.id, 0, 200);
      expect(messages).toHaveLength(1);
      expect(await verifyChain(record.id, messages)).toEqual({ ok: true });
      expect((await store.getSession(record.id))?.lastHash).toBe(messages[0].hash);
    });

    for (const state of ["stopped", "expired"] as const) {
      test(`${state} sessions reject new appends`, async () => {
        const store = makeStore();
        await store.createSession({ ...record, state });
        await expect(append(store)).rejects.toBeInstanceOf(SessionNotActive);
        expect(await store.listMessages(record.id, 0, 200)).toEqual([]);
      });

      test(`${state} while hashing is terminal and prevents append`, async () => {
        const store = makeStore();
        await store.createSession(record);
        const entered = deferred();
        const release = deferred();
        const pending = store.appendMessage(record.id, input, async (seq) => {
          entered.resolve();
          await release.promise;
          return chainHash(record.id, seq, input.ciphertext);
        });
        await entered.promise;
        await store.updateSession(record.id, (s) => ({ ...s, state }));
        release.resolve();
        await expect(pending).rejects.toBeInstanceOf(SessionNotActive);
        expect(await store.getSession(record.id)).toMatchObject({
          state,
          lastSeq: 0,
          lastHash: "",
        });
        expect(await store.listMessages(record.id, 0, 200)).toEqual([]);
      });
    }

    test("extension while hashing preserves the new TTL and expiry", async () => {
      const store = makeStore();
      await store.createSession(record);
      const entered = deferred();
      const release = deferred();
      const pending = store.appendMessage(record.id, input, async (seq) => {
        entered.resolve();
        await release.promise;
        return chainHash(record.id, seq, input.ciphertext);
      });
      await entered.promise;
      const expiresAt = "2026-09-18T01:00:00Z";
      await store.updateSession(record.id, (s) => ({ ...s, ttlSeconds: 3600, expiresAt }));
      release.resolve();
      await pending;
      expect(await store.getSession(record.id)).toMatchObject({
        ttlSeconds: 3600,
        expiresAt,
        lastSeq: 1,
      });
    });
  });
}

describe("GCS cursor publication", () => {
  test("message upload 503 leaves cursor untouched; a new instance retries without a gap", async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    h.hooks.before = async (name, req) => {
      if (req.method === "POST" && name.includes("/msgs/")) {
        h.hooks.before = undefined;
        return new Response(null, { status: 503 });
      }
    };
    await expect(append(store)).rejects.toThrow("HTTP 503");
    expect(await store.getSession(record.id)).toMatchObject({ lastSeq: 0, lastHash: "" });
    const restarted = h.makeStore();
    const first = await append(restarted);
    await append(restarted, "second", first.hash);
    const messages = await restarted.listMessages(record.id, 0, 200);
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(await verifyChain(record.id, messages)).toEqual({ ok: true });
  });

  test("failed cursor publication leaves an invisible orphan that cannot block or replace a retry", async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    h.hooks.before = async (name, req) => {
      if (req.method === "POST" && name === stateObject) {
        h.hooks.before = undefined;
        return new Response(null, { status: 503 });
      }
    };
    await expect(append(store, "orphan")).rejects.toThrow("HTTP 503");
    expect([...h.objects.keys()].filter((key) => key.includes("/msgs/"))).toHaveLength(1);
    expect(await store.listMessages(record.id, 0, 200)).toEqual([]);
    const committed = await append(h.makeStore(), "replacement");
    expect(committed.seq).toBe(1);
    expect(await store.listMessages(record.id, 0, 200)).toEqual([committed]);
  });

  test("two instances racing identical ciphertext cannot publish the losing nonce", async () => {
    const h = gcsHarness();
    const a = h.makeStore();
    const b = h.makeStore();
    await a.createSession(record);
    const both = deferred();
    let uploads = 0;
    h.hooks.before = async (name, req) => {
      if (req.method === "POST" && name.includes("/msgs/")) {
        if (++uploads === 2) both.resolve();
        await both.promise;
      }
      return undefined;
    };
    const results = await Promise.allSettled(
      [a, b].map((store, i) =>
        store.appendMessage(record.id, { ...input, nonce: `nonce-${i}` }, (seq) =>
          chainHash(record.id, seq, input.ciphertext),
        ),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await b.listMessages(record.id, 0, 200)).toEqual([winners[0].value]);
    expect([...h.objects.keys()].filter((key) => key.includes("/msgs/"))).toHaveLength(2);
  });

  test("stop during upload wins cursor CAS and keeps the candidate invisible", async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    h.hooks.after = async (name) => {
      if (name.includes("/msgs/")) {
        h.hooks.after = undefined;
        await h.makeStore().updateSession(record.id, (s) => ({ ...s, state: "stopped" }));
      }
      return undefined;
    };
    await expect(append(store)).rejects.toBeInstanceOf(SessionNotActive);
    expect(await store.getSession(record.id)).toMatchObject({ state: "stopped", lastSeq: 0 });
    expect(await store.listMessages(record.id, 0, 200)).toEqual([]);
  });

  test("lost cursor acknowledgement still leaves a readable committed message", async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    h.hooks.after = async (name) => {
      if (name === stateObject) {
        h.hooks.after = undefined;
        return new Response(null, { status: 503 });
      }
    };
    await expect(append(store)).rejects.toThrow("HTTP 503");
    await expect(append(h.makeStore())).rejects.toBeInstanceOf(ChainMismatch);
    const committed = await store.listMessages(record.id, 0, 200);
    expect(committed).toHaveLength(1);
    await append(store, "second", committed[0].hash);
    expect(await verifyChain(record.id, await store.listMessages(record.id, 0, 200))).toEqual({
      ok: true,
    });
  });

  test("pagination follows committed order and missing committed objects explicitly fail", async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    const first = await append(store);
    const second = await append(store, "second", first.hash);
    await append(store, "third", second.hash);
    expect(await store.listMessages(record.id, 0, 1)).toEqual([first]);
    expect(await store.listMessages(record.id, 1, 1)).toEqual([second]);
    expect(await store.listMessages(record.id, 3, 200)).toEqual([]);
    const firstObject = [...h.objects.keys()].find((key) => key.includes("/msgs/"));
    if (!firstObject) throw new Error("fixture is missing first message");
    h.objects.delete(firstObject);
    await expect(store.listMessages(record.id, 0, 200)).rejects.toThrow(
      "missing committed message 1",
    );
    await expect(store.listMessages(record.id, 0, 1)).rejects.toThrow(
      "missing committed message 1",
    );
  });
});

test("HTTP append reports a concurrent stop as session_not_active", async () => {
  class StoppingStore extends MemoryStore {
    override appendMessage(...[id, message, hashFor]: Parameters<Store["appendMessage"]>) {
      return super.appendMessage(id, message, async (seq) => {
        await this.updateSession(id, (s) => ({ ...s, state: "stopped" }));
        return hashFor(seq);
      });
    }
  }
  const store = new StoppingStore();
  const app = createApp({ store, apiKeys: new Map([["test", "key"]]) });
  const created = await app.fetch(
    new Request("http://test/v1/sessions", {
      method: "POST",
      headers: { authorization: "Bearer key" },
    }),
  );
  const { id, agent_token } = (await created.json()) as { id: string; agent_token: string };
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

for (const field of ["seq", "hash"] as const) {
  test(`GCS rejects a committed object whose ${field} disagrees with the cursor`, async () => {
    const h = gcsHarness();
    const store = h.makeStore();
    await store.createSession(record);
    await append(store);
    for (const [key, object] of h.objects) {
      if (!key.includes("/msgs/")) continue;
      const body = JSON.parse(object.body);
      body.message[field] = field === "seq" ? 99 : "wrong-hash";
      h.objects.set(key, { ...object, body: JSON.stringify(body) });
    }
    await expect(store.listMessages(record.id, 0, 200)).rejects.toThrow(
      "invalid committed message 1",
    );
  });
}
