import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createApp } from "./app";
import { nonnegativeEnv, serverPolicy } from "./config";
import { HttpKeyResolver, type KeyClaims, StaticKeyResolver, hashKey } from "./key-resolver";
import { MemoryStore } from "./memory-store";
import { HttpUsageSink, type UsageEvent, type UsageSink } from "./usage";

const rawKey = "platform-fixture-credential";
const start = Date.parse("2030-01-01T00:00:00Z");
afterEach(() => setSystemTime());

function harness(options: { anonymousQps?: number; qps?: number; usageSink?: UsageSink } = {}) {
  let claims: KeyClaims | null = { subject: "account", tier: "test", qps: options.qps ?? 0 };
  let down = false;
  const requests: Request[] = [];
  const events: UsageEvent[] = [];
  const resolver = new HttpKeyResolver({
    url: "https://key-service.invalid",
    token: "service-fixture-credential",
    cacheSeconds: 0,
    fetch: async (req) => {
      requests.push(req);
      if (down) throw new Error("private backend detail");
      expect(req.headers.get("authorization")).toBe("Bearer service-fixture-credential");
      expect(new URL(req.url).searchParams.get("key")).toBe(await hashKey(rawKey));
      return claims
        ? Response.json(claims)
        : Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  const store = new MemoryStore();
  const app = createApp({
    store,
    keyResolver: resolver,
    anonymousQps: options.anonymousQps ?? 0,
    usageSink: options.usageSink ?? {
      record: (event) => {
        events.push(event);
      },
    },
    limits: { activePerIp: 100 },
  });
  const call = (path: string, token?: string, method = "GET", body?: unknown, ip = "192.0.2.1") =>
    app.fetch(
      new Request(`https://server.invalid${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
      { requestIP: () => ({ address: ip }) },
    );
  const create = (token: string | undefined = rawKey) =>
    call("/v1/sessions", token, "POST", { id: crypto.randomUUID().replaceAll("-", "") });
  return {
    call,
    create,
    store,
    events,
    requests,
    setClaims: (next: KeyClaims | null) => {
      claims = next;
    },
    setDown: () => {
      down = true;
    },
  };
}

test("keyed sessions retain only fingerprints and pair without platform credentials when anonymous is disabled", async () => {
  const h = harness();
  const created = await h.create();
  expect(created.status).toBe(201);
  const session = await created.json();
  const saved = await h.store.getSession(session.id);
  expect(saved?.keyBinding).toEqual({ keyHash: await hashKey(rawKey), subject: "account" });
  expect(JSON.stringify(saved)).not.toContain(rawKey);
  const redeemed = await h.call(`/v1/sessions/${session.id}/redeem`, undefined, "POST");
  expect(redeemed.status).toBe(200);
  const { browser_token } = await redeemed.json();
  for (let i = 0; i < 25; i++)
    expect((await h.call(`/v1/sessions/${session.id}`, browser_token)).status).toBe(200);
  expect((await h.call(`/v1/sessions/${session.id}`, rawKey)).status).toBe(401);
  expect((await h.call("/docs", rawKey)).status).toBe(200);
  expect((await h.call("/docs")).status).toBe(401);
  expect(JSON.stringify(h.events)).not.toContain(rawKey);
  expect(JSON.stringify(h.events)).not.toContain(browser_token);
});

test("key revocation and subject reassignment fail closed on established sessions", async () => {
  for (const policy of [null, { subject: "someone-else", tier: "test", qps: 0 }]) {
    const h = harness();
    const session = await (await h.create()).json();
    h.setClaims(policy);
    expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(401);
    expect((await h.call(`/v1/sessions/${session.id}/redeem`, undefined, "POST")).status).toBe(401);
    expect((await h.store.getSession(session.id))?.state).toBe("created");
  }
});

test("service outage refuses keyed calls without affecting anonymous requests or leaking diagnostics", async () => {
  const h = harness({ anonymousQps: 10 });
  const session = await (await h.create()).json();
  h.setDown();
  const failed = await h.call(`/v1/sessions/${session.id}`, session.agent_token);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    error: "key_service_unavailable",
    message: "key service unavailable",
  });
  const calls = h.requests.length;
  expect((await h.call("/v1/sessions", undefined, "POST", { id: "a".repeat(32) })).status).toBe(
    201,
  );
  expect((await h.call("/docs")).status).toBe(200);
  expect(h.requests.length).toBe(calls);
  expect((await h.create()).status).toBe(503);
});

test("every keyed API request including redeem, long poll, docs, errors and stop consumes one shared subject allowance", async () => {
  setSystemTime(new Date(start));
  const h = harness({ qps: 1 });
  const session = await (await h.create()).json();
  const paths: [string, string | undefined, string, number][] = [
    [`/v1/sessions/${session.id}/redeem`, undefined, "POST", 200],
    [`/v1/sessions/${session.id}/messages?wait=0`, session.agent_token, "GET", 200],
    ["/docs", rawKey, "GET", 200],
    ["/client-code", rawKey, "GET", 200],
    ["/unknown", rawKey, "GET", 404],
    [`/v1/sessions/${session.id}/stop`, session.agent_token, "POST", 200],
  ];
  for (const [index, [path, token, method, status]] of paths.entries()) {
    expect((await h.call(path, token, method)).status).toBe(429);
    setSystemTime(new Date(start + (index + 1) * 1000));
    expect((await h.call(path, token, method)).status).toBe(status);
    const limited = await h.call(
      `/v1/sessions/${session.id}`,
      session.agent_token,
      "GET",
      undefined,
      "192.0.2.2",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect((await limited.json()).error).toBe("rate_limited");
  }
});

test("QPS and tier refresh keep the subject counter, with unlimited bypass retaining earlier consumption", async () => {
  setSystemTime(new Date(start));
  const h = harness({ qps: 2 });
  const session = await (await h.create()).json();
  h.setClaims({ subject: "account", tier: "raised", qps: 3 });
  expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(200);
  h.setClaims({ subject: "account", tier: "unlimited", qps: 0 });
  expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(200);
  h.setClaims({ subject: "account", tier: "lowered", qps: 2 });
  expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(429);
});

test("usage reports successful writes and quota denials, but never counts reads as writes", async () => {
  const h = harness();
  const session = await (await h.create()).json();
  await h.call(`/v1/sessions/${session.id}/redeem`, undefined, "POST");
  const message = await h.call(`/v1/sessions/${session.id}/messages`, session.agent_token, "POST", {
    role: "agent",
    prev_hash: "",
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  });
  expect(message.status).toBe(201);
  const blob = await h.call(
    `/v1/sessions/${session.id}/blobs`,
    session.agent_token,
    "POST",
    "ciphertext",
  );
  expect(blob.status).toBe(201);
  expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(200);
  h.setClaims({ subject: "account", tier: "limited", qps: 1 });
  await h.call(`/v1/sessions/${session.id}`, session.agent_token);
  expect((await h.call(`/v1/sessions/${session.id}`, session.agent_token)).status).toBe(429);
  expect(h.events.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
    { kind: "session_created", amount: 1 },
    { kind: "message", amount: 1 },
    { kind: "blob_bytes", amount: 10 },
    { kind: "throttled", amount: 1 },
  ]);
  expect(h.events.every((event) => event.subject === "account" && !event.ip)).toBe(true);
});

test("throwing or asynchronously rejecting sinks cannot alter a successful response", async () => {
  for (const record of [
    () => {
      throw new Error("sink unavailable");
    },
    async () => {
      throw new Error("sink unavailable");
    },
  ]) {
    const h = harness({ usageSink: { record } });
    expect((await h.create()).status).toBe(201);
    await Promise.resolve();
  }
});

test("HTTP usage delivery failure cannot alter a successful create response", async () => {
  let deliveries = 0;
  const diagnostics: string[] = [];
  const sink = new HttpUsageSink({
    url: "https://usage.invalid/events",
    token: "service-fixture-credential",
    logger: (line) => diagnostics.push(line),
    fetch: async () => {
      deliveries++;
      throw new Error("private transport failure");
    },
  });
  try {
    const h = harness({ usageSink: sink });
    const response = await h.create();
    expect(response.status).toBe(201);
    expect(deliveries).toBe(0);
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(deliveries).toBe(1);
    const session = await response.json();
    expect((await h.store.getSession(session.id))?.state).toBe("created");
    expect(response.status).toBe(201);
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("private transport failure");
  } finally {
    await sink.close();
  }
});

test("anonymous default is ten requests per IP and keys remain optional even with a configured resolver", async () => {
  const app = createApp({
    store: new MemoryStore(),
    keyResolver: new StaticKeyResolver("test:valid:0"),
    usageSink: { record() {} },
  });
  const docs = (ip: string, token?: string) =>
    app.fetch(
      new Request("https://server.invalid/docs", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      { requestIP: () => ({ address: ip }) },
    );
  for (let i = 0; i < 10; i++) expect((await docs("192.0.2.1")).status).toBe(200);
  expect((await docs("192.0.2.1")).status).toBe(429);
  expect((await docs("192.0.2.2")).status).toBe(200);
  expect((await docs("192.0.2.1", "valid")).status).toBe(200);
  expect((await docs("192.0.2.3", "unknown")).status).toBe(401);
});

test("configuration validates optional integers and requires the HTTP service token", async () => {
  expect(nonnegativeEnv({}, "QPS", 10)).toBe(10);
  expect(nonnegativeEnv({ QPS: "0" }, "QPS", 10)).toBe(0);
  for (const QPS of ["-1", "1.5", "NaN", "Infinity", "9007199254740992"])
    expect(() => nonnegativeEnv({ QPS }, "QPS", 10)).toThrow("nonnegative safe integer");
  expect(() => serverPolicy({ REMOTE_TAB_KEY_SERVICE_URL: "https://keys.invalid" })).toThrow(
    "REMOTE_TAB_KEY_SERVICE_TOKEN",
  );
  expect(() => serverPolicy({ REMOTE_TAB_USAGE_URL: "https://usage.invalid" })).toThrow(
    "REMOTE_TAB_KEY_SERVICE_TOKEN",
  );
  const policy = serverPolicy({
    REMOTE_TAB_API_KEYS: "test:valid:7",
    REMOTE_TAB_ANONYMOUS_QPS: "0",
    REMOTE_TAB_TRUST_PROXY_HOPS: "2",
  });
  expect(policy.anonymousQps).toBe(0);
  expect(policy.trustProxyHops).toBe(2);
  expect(await policy.keyResolver.resolve("valid")).toEqual({
    subject: "test",
    tier: "static",
    qps: 7,
  });
  await policy.usageSink.close?.();
});

test("key-policy refresh crossing expiry cannot authorize messages or blobs and reports expired status", async () => {
  for (const operation of ["message", "blob", "status"] as const) {
    let now = start;
    let expireDuringRefresh = false;
    const claims = { subject: "account", tier: "test", qps: 0 };
    const store = new MemoryStore();
    const app = createApp({
      store,
      anonymousQps: 0,
      now: () => new Date(now),
      usageSink: { record() {} },
      keyResolver: {
        resolve: async () => claims,
        resolveHash: async () => {
          if (expireDuringRefresh) now += 61_000;
          return claims;
        },
      },
    });
    const id = "a".repeat(32);
    const call = (path: string, method: string, token?: string, body?: string) =>
      app.fetch(
        new Request(`https://server.invalid${path}`, {
          method,
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body,
        }),
      );
    const created = await call(
      "/v1/sessions",
      "POST",
      rawKey,
      JSON.stringify({ id, ttl_seconds: 60 }),
    );
    expect(created.status).toBe(201);
    const { agent_token } = await created.json();
    expect((await call(`/v1/sessions/${id}/redeem`, "POST")).status).toBe(200);
    expireDuringRefresh = true;
    const response =
      operation === "message"
        ? await call(
            `/v1/sessions/${id}/messages`,
            "POST",
            agent_token,
            JSON.stringify({
              role: "agent",
              prev_hash: "",
              nonce: "A".repeat(16),
              ciphertext: "A".repeat(22),
            }),
          )
        : operation === "blob"
          ? await call(`/v1/sessions/${id}/blobs`, "POST", agent_token, "ciphertext")
          : await call(`/v1/sessions/${id}`, "GET", agent_token);
    if (operation === "status") {
      expect(response.status).toBe(200);
      expect((await response.json()).state).toBe("expired");
    } else {
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("session_not_active");
    }
    const saved = await store.getSession(id);
    expect(saved?.lastSeq).toBe(0);
    expect(saved?.blobBytes ?? 0).toBe(0);
  }
});
