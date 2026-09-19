import { describe, expect, test } from "bun:test";
import { LIMITS } from "@remote-tab/protocol";
import { chainHash } from "@remote-tab/protocol/src/crypto";
import { createApp, parseApiKeys } from "./app";
import { StaticKeyResolver } from "./key-resolver";
import { MemoryStore } from "./memory-store";

const API_KEY = "test-platform-key-0123456789";
const NONCE = "AAAAAAAAAAAAAAAA"; // 12 zero bytes
const CT = "Y2lwaGVydGV4dC1ieXRlcy1oZXJl"; // any base64url ≥ 22 chars

function harness(nowMs?: () => number) {
  const app = createApp({
    store: new MemoryStore(nowMs ? () => new Date(nowMs()) : undefined),
    keyResolver: new StaticKeyResolver(new Map([["test", API_KEY]]), { defaultQps: 0 }),
    anonymousQps: 0,
    now: nowMs ? () => new Date(nowMs()) : undefined,
    blobMaxBytes: 1024,
  });
  const call = (path: string, init: RequestInit = {}, token?: string) =>
    app.fetch(
      new Request(`http://rt.test${path}`, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );
  return { call };
}

async function createSession(call: ReturnType<typeof harness>["call"], ttl?: number) {
  const res = await call(
    "/v1/sessions",
    {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID().replaceAll("-", ""), ttl_seconds: ttl }),
    },
    API_KEY,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    agent_token: string;
    expires_at: string;
    redeem_until: string;
  };
}

async function redeem(call: ReturnType<typeof harness>["call"], id: string) {
  const res = await call(`/v1/sessions/${id}/redeem`, { method: "POST" });
  return {
    status: res.status,
    body: (await res.json()) as { browser_token?: string; error?: string },
  };
}

describe("server serves nothing but the API", () => {
  test("root, html-looking paths, and unknown routes are 404 JSON", async () => {
    const { call } = harness();
    for (const p of ["/", "/index.html", "/s/abc", "/l/abc", "/v1", "/v1/other"]) {
      const res = await call(p, {}, API_KEY);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });
});

describe("create + redeem", () => {
  test("creation requires an explicit canonical session ID and never generates a replacement", async () => {
    for (const body of [
      undefined,
      {},
      { id: null },
      { id: 42 },
      { id: "a".repeat(31) },
      { id: "a".repeat(33) },
      { id: "A".repeat(32) },
      { id: "g".repeat(32) },
      { id: crypto.randomUUID() },
      { id: "../state" },
    ]) {
      const { call } = harness();
      const response = await call(
        "/v1/sessions",
        { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
        API_KEY,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid");
    }
    const { call } = harness();
    const id = "0123456789abcdef".repeat(2);
    const response = await call(
      "/v1/sessions",
      { method: "POST", body: JSON.stringify({ id }) },
      API_KEY,
    );
    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session.id).toBe(id);
    expect((await call(`/v1/sessions/${id}`, {}, session.agent_token)).status).toBe(200);
    expect((await redeem(call, id)).status).toBe(200);
  });

  test("requires a platform key", async () => {
    const { call } = harness();
    expect((await call("/v1/sessions", { method: "POST" })).status).toBe(401);
    expect((await call("/v1/sessions", { method: "POST" }, "wrong")).status).toBe(401);
  });

  test("ttl defaults and caps", async () => {
    const { call } = harness();
    const s = await createSession(call);
    expect(new Date(s.expires_at).getTime() - Date.now()).toBeGreaterThan(
      LIMITS.ttlDefaultSeconds * 1000 - 5000,
    );
    const over = await call(
      "/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ id: "a".repeat(32), ttl_seconds: LIMITS.ttlMaxSeconds + 1 }),
      },
      API_KEY,
    );
    expect(over.status).toBe(400);
    expect((await over.json()).error).toBe("ttl_exceeded");
  });

  test("redeem is one-shot and needs no token", async () => {
    const { call } = harness();
    const s = await createSession(call);
    const first = await redeem(call, s.id);
    expect(first.status).toBe(200);
    expect(first.body.browser_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await redeem(call, s.id);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_redeemed");
  });

  test("redeem window closes after 10 minutes even though the session is alive", async () => {
    let t = Date.parse("2026-09-18T20:00:00Z");
    const { call } = harness(() => t);
    const s = await createSession(call);
    t += (LIMITS.redeemWindowSeconds + 1) * 1000;
    const r = await redeem(call, s.id);
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("redeem_window_closed");
  });

  test("unknown session id shapes are 404, not 400 (no oracle)", async () => {
    const { call } = harness();
    expect((await call("/v1/sessions/not-a-session-id/redeem", { method: "POST" })).status).toBe(
      404,
    );
    expect(
      (await call("/v1/sessions/6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c/redeem", { method: "POST" }))
        .status,
    ).toBe(404);
  });
});

describe("messages and the chain", () => {
  async function activeSession() {
    const { call } = harness();
    const s = await createSession(call);
    const r = await redeem(call, s.id);
    return { call, id: s.id, agent: s.agent_token, browser: r.body.browser_token as string };
  }

  test("append enforces token role and prev_hash; server computes the chain hash", async () => {
    const { call, id, agent, browser } = await activeSession();
    const bad = await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "browser", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      agent,
    );
    expect(bad.status).toBe(400);
    const first = await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "agent", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      agent,
    );
    expect(first.status).toBe(201);
    const { seq, hash } = (await first.json()) as { seq: number; hash: string };
    expect(seq).toBe(1);
    expect(hash).toBe(await chainHash(id, 1, CT));
    const stale = await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "browser", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      browser,
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).expected_prev_hash).toBe(hash);
    const second = await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "browser", prev_hash: hash, nonce: NONCE, ciphertext: CT }),
      },
      browser,
    );
    expect(second.status).toBe(201);
    expect(((await second.json()) as { seq: number }).seq).toBe(2);
  });

  test("message cursor rejects unsafe integers before reaching the store", async () => {
    const { call, id, agent } = await activeSession();
    const response = await call(`/v1/sessions/${id}/messages?after=9007199254740992`, {}, agent);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid");
  });

  test("list after seq and long-poll wake-up", async () => {
    const { call, id, agent, browser } = await activeSession();
    const empty = await call(`/v1/sessions/${id}/messages?after=0`, {}, agent);
    expect(((await empty.json()) as { messages: unknown[] }).messages).toEqual([]);
    const waiting = call(`/v1/sessions/${id}/messages?after=0&wait=5`, {}, agent);
    await new Promise((r) => setTimeout(r, 50));
    await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "browser", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      browser,
    );
    const started = Date.now();
    const res = await waiting;
    expect(Date.now() - started).toBeLessThan(3000);
    const body = (await res.json()) as {
      messages: Array<{ seq: number; role: string; prev_hash: string }>;
    };
    expect(body.messages.map((m) => [m.seq, m.role, m.prev_hash])).toEqual([[1, "browser", ""]]);
  });

  test("message size cap", async () => {
    const { call, id, agent } = await activeSession();
    const huge = "A".repeat(LIMITS.messageMaxBytes);
    const res = await call(
      `/v1/sessions/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "agent", prev_hash: "", nonce: NONCE, ciphertext: huge }),
      },
      agent,
    );
    expect(res.status).toBe(413);
  });

  test("messages are refused before redeem and after stop", async () => {
    const { call } = harness();
    const s = await createSession(call);
    const early = await call(
      `/v1/sessions/${s.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "agent", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      s.agent_token,
    );
    expect(early.status).toBe(409);
    await redeem(call, s.id);
    expect(
      (await call(`/v1/sessions/${s.id}/stop`, { method: "POST" }, s.agent_token)).status,
    ).toBe(200);
    const late = await call(
      `/v1/sessions/${s.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "agent", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      s.agent_token,
    );
    expect(late.status).toBe(409);
    const st = (await (await call(`/v1/sessions/${s.id}`, {}, s.agent_token)).json()) as {
      state: string;
    };
    expect(st.state).toBe("stopped");
  });
});

describe("blobs, extend, expiry", () => {
  test("blob round-trip and cap", async () => {
    const { call } = harness();
    const s = await createSession(call);
    const r = await redeem(call, s.id);
    const bytes = new Uint8Array(512).fill(7);
    const up = await call(
      `/v1/sessions/${s.id}/blobs`,
      { method: "POST", body: bytes },
      r.body.browser_token,
    );
    expect(up.status).toBe(201);
    const { blob_id } = (await up.json()) as { blob_id: string };
    const down = await call(`/v1/sessions/${s.id}/blobs/${blob_id}`, {}, s.agent_token);
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
    const big = await call(
      `/v1/sessions/${s.id}/blobs`,
      { method: "POST", body: new Uint8Array(2048) },
      s.agent_token,
    );
    expect(big.status).toBe(413);
    expect((await call(`/v1/sessions/${s.id}/blobs/nope`, {}, s.agent_token)).status).toBe(404);
  });

  test("only the browser can extend, and only up to the max", async () => {
    const { call } = harness();
    const s = await createSession(call);
    const r = await redeem(call, s.id);
    expect(
      (await call(`/v1/sessions/${s.id}/extend`, { method: "POST" }, s.agent_token)).status,
    ).toBe(401);
    const ok = await call(`/v1/sessions/${s.id}/extend`, { method: "POST" }, r.body.browser_token);
    expect(ok.status).toBe(200);
    const again = await call(
      `/v1/sessions/${s.id}/extend`,
      { method: "POST" },
      r.body.browser_token,
    );
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("ttl_exceeded");
  });

  test("expiry is enforced on read without a sweeper", async () => {
    let t = Date.parse("2026-09-18T20:00:00Z");
    const { call } = harness(() => t);
    const s = await createSession(call, 60);
    await redeem(call, s.id);
    t += 61_000;
    const st = (await (await call(`/v1/sessions/${s.id}`, {}, s.agent_token)).json()) as {
      state: string;
    };
    expect(st.state).toBe("expired");
    const post = await call(
      `/v1/sessions/${s.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role: "agent", prev_hash: "", nonce: NONCE, ciphertext: CT }),
      },
      s.agent_token,
    );
    expect(post.status).toBe(409);
  });
});

test("parseApiKeys", () => {
  expect([...parseApiKeys("a:1, b:2,,")]).toEqual([
    ["a", "1"],
    ["b", "2"],
  ]);
  expect(() => parseApiKeys("nocolon")).toThrow();
});
