import { describe, expect, test } from "bun:test";
import { HttpKeyResolver, KeyServiceUnavailable, StaticKeyResolver, hashKey } from "./key-resolver";
const value = { tier: "verified", subject: "account-one", qps: 12 };
function resolver(options: Partial<ConstructorParameters<typeof HttpKeyResolver>[0]> = {}) {
  return new HttpKeyResolver({
    url: "https://keys.example/base",
    token: "test-service-token",
    ...options,
  });
}
describe("static keys", () => {
  test("legacy keys, explicit quota, colon migration and hash resolution", async () => {
    const keys = new StaticKeyResolver("old:test-old,new:test-new:0,colon:test:123:7");
    expect(await keys.resolve("test-old")).toEqual({ tier: "static", subject: "old", qps: 10 });
    expect(await keys.resolveHash(await hashKey("test-new"))).toEqual({
      tier: "static",
      subject: "new",
      qps: 0,
    });
    expect((await keys.resolve("test:123"))?.qps).toBe(7);
    expect(await keys.resolve("missing")).toBeNull();
    expect(await hashKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const mapped = new StaticKeyResolver(new Map([["fixture", "test-key"]]), { defaultQps: 0 });
    expect((await mapped.resolve("test-key"))?.qps).toBe(0);
    const result = await mapped.resolve("test-key");
    if (result) result.subject = "mutated";
    expect((await mapped.resolve("test-key"))?.subject).toBe("fixture");
  });
  test("invalid claims and ambiguous identities fail without credential text", () => {
    for (const input of [
      "bad",
      "empty:",
      "a:test:-1",
      "a:test:1.5",
      "a:test:Infinity",
      "a:test:NaN",
      "a:test:9007199254740992",
      "a:test,b:test",
    ]) {
      expect(() => new StaticKeyResolver(input)).toThrow();
    }
    expect(() => new StaticKeyResolver("a:test", { defaultQps: -1 })).toThrow("invalid key claims");
  });
});
describe("HTTP key resolver", () => {
  test("hash-only request, immutable cache, positive expiry and subject rotation", async () => {
    let now = 0;
    let calls = 0;
    const keys = resolver({
      now: () => now,
      fetch: async (request) => {
        calls++;
        expect(request.url).toBe(
          `https://keys.example/base/resolve?key=${await hashKey("test-platform-key")}`,
        );
        expect(request.headers.get("authorization")).toBe("Bearer test-service-token");
        expect(request.redirect).toBe("error");
        return Response.json({ ...value, subject: calls === 1 ? "account-one" : "account-two" });
      },
    });
    const first = await keys.resolve("test-platform-key");
    if (first) first.qps = 999;
    expect((await keys.resolve("test-platform-key"))?.qps).toBe(12);
    expect(calls).toBe(1);
    now = 300000;
    expect((await keys.resolve("test-platform-key"))?.subject).toBe("account-two");
    expect(calls).toBe(2);
  });
  test("only 404 is a negative cache, which expires after sixty seconds", async () => {
    let now = 0;
    let calls = 0;
    const keys = resolver({
      now: () => now,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    });
    expect(await keys.resolve("test-missing")).toBeNull();
    now = 59999;
    expect(await keys.resolve("test-missing")).toBeNull();
    expect(calls).toBe(1);
    now++;
    await keys.resolve("test-missing");
    expect(calls).toBe(2);
  });
  test("expiry never serves stale approval, failures never expose downstream text", async () => {
    let now = 0;
    let down = false;
    const keys = resolver({
      now: () => now,
      fetch: async () => {
        if (down) throw new Error("private-downstream-diagnostic");
        return Response.json(value);
      },
    });
    await keys.resolve("test-key");
    down = true;
    now = 300000;
    await expect(keys.resolve("test-key")).rejects.toThrow("key service unavailable");
    down = false;
    expect(await keys.resolve("test-key")).toEqual(value);
  });
  test("invalid statuses and claims fail closed", async () => {
    for (const status of [400, 401, 403, 429, 500, 503, 302]) {
      await expect(
        resolver({ fetch: async () => new Response("private", { status }) }).resolve("test-key"),
      ).rejects.toBeInstanceOf(KeyServiceUnavailable);
    }
    for (const bad of [
      { ...value, qps: -1 },
      { ...value, qps: 1.2 },
      { ...value, qps: "1" },
      { ...value, subject: "" },
      { ...value, tier: "" },
      null,
    ]) {
      await expect(
        resolver({ fetch: async () => Response.json(bad) }).resolve("test-key"),
      ).rejects.toBeInstanceOf(KeyServiceUnavailable);
    }
  });
  test("bounded cache and zero positive TTL", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return Response.json(value);
    };
    const keys = resolver({ maxEntries: 1, fetch });
    await keys.resolve("a");
    await keys.resolve("b");
    await keys.resolve("a");
    expect(calls).toBe(3);
    const uncached = resolver({ cacheSeconds: 0, fetch });
    await uncached.resolve("a");
    await uncached.resolve("a");
    expect(calls).toBe(5);
  });
  test("deduplicates concurrent same-key calls and bounds other in-flight keys", async () => {
    let finish!: (r: Response) => void;
    let calls = 0;
    const keys = resolver({
      maxInFlight: 1,
      fetch: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const first = keys.resolve("a");
    const second = keys.resolve("a");
    await expect(keys.resolve("b")).rejects.toBeInstanceOf(KeyServiceUnavailable);
    finish(Response.json(value));
    expect(await first).toEqual(value);
    expect(await second).toEqual(value);
    expect(calls).toBe(1);
  });
  test("timeouts cover stalled fetch and stalled body; oversized body cancels", async () => {
    await expect(
      resolver({ timeoutMs: 5, fetch: async () => new Promise(() => {}) }).resolve("a"),
    ).rejects.toBeInstanceOf(KeyServiceUnavailable);
    let canceled = false;
    const stream = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    await expect(
      resolver({ timeoutMs: 5, fetch: async () => new Response(stream) }).resolve("a"),
    ).rejects.toBeInstanceOf(KeyServiceUnavailable);
    expect(canceled).toBe(true);
    canceled = false;
    const huge = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8193));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(
      resolver({ fetch: async () => new Response(huge) }).resolve("a"),
    ).rejects.toBeInstanceOf(KeyServiceUnavailable);
    expect(canceled).toBe(true);
  });
  test("ignored abort cannot exceed the physical transport limit", async () => {
    let calls = 0;
    const keys = resolver({
      maxInFlight: 1,
      timeoutMs: 5,
      fetch: async () => {
        calls++;
        return new Promise(() => {});
      },
    });
    await expect(keys.resolve("a")).rejects.toBeInstanceOf(KeyServiceUnavailable);
    await expect(keys.resolve("b")).rejects.toBeInstanceOf(KeyServiceUnavailable);
    await expect(keys.resolve("a")).rejects.toBeInstanceOf(KeyServiceUnavailable);
    expect(calls).toBe(1);
  });
  test("configuration and fingerprint validation", async () => {
    for (const url of [
      "http://keys.example",
      "http://127.attacker.example",
      "https://u:p@keys.example",
      "https://keys.example/?x=y",
      "https://keys.example/#x",
    ])
      expect(() => resolver({ url })).toThrow("invalid key service configuration");
    expect(() => resolver({ url: "http://127.0.0.1:9000" })).not.toThrow();
    await expect(resolver().resolveHash("raw-not-hash")).rejects.toBeInstanceOf(
      KeyServiceUnavailable,
    );
  });
});
