import { expect, test } from "bun:test";
import {
  HttpUsageSink,
  LogUsageSink,
  MAX_USAGE_AMOUNT,
  type UsageEvent,
  type UsageKind,
} from "./usage";

const at = "2026-09-19T00:00:20.000Z";
const event = (
  kind: UsageKind = "message",
  amount = 1,
): Extract<UsageEvent, { subject: string }> => ({
  subject: "opaque-customer",
  tier: "custom-tier",
  kind,
  amount,
  at,
});
const url = "https://usage.example/events";
const token = "service-token-must-not-appear-in-logs";
const decode = (lines: string[]) => lines.map((line) => JSON.parse(line));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("log usage aggregates all kinds by minute, identity type, tier and kind without extra fields", async () => {
  const lines: string[] = [];
  const sink = new LogUsageSink({ logger: (line) => lines.push(line), now: () => Date.parse(at) });
  try {
    for (const kind of ["session_created", "message", "blob_bytes", "throttled"] as const) {
      sink.record(event(kind, 2));
      sink.record(event(kind, 3));
    }
    sink.record({ ip: "opaque-customer", tier: "custom-tier", kind: "message", amount: 7, at });
    sink.record({ ...event(), tier: "other-tier", amount: 11 });
    sink.record({ ...event(), amount: 13, at: "2026-09-19T00:01:00.000Z" });
    const item = {
      ...event(),
      amount: 17,
      secret: "must-not-log",
      url: "https://private.example",
      token,
    };
    sink.record(item);
    item.amount = 500;
    expect(lines).toEqual([]); // No logging on the request path.
    await sink.flush();
    expect(lines).toHaveLength(7);
    expect(decode(lines)).toContainEqual({
      subject: "opaque-customer",
      tier: "custom-tier",
      kind: "message",
      amount: 22,
      at: "2026-09-19T00:00:00.000Z",
    });
    expect(decode(lines)).toContainEqual({
      ip: "opaque-customer",
      tier: "custom-tier",
      kind: "message",
      amount: 7,
      at: "2026-09-19T00:00:00.000Z",
    });
    expect(lines.join("\n")).not.toContain("must-not-log");
    expect(lines.join("\n")).not.toContain("private.example");
    expect(lines.join("\n")).not.toContain(token);
    await sink.flush();
    expect(lines).toHaveLength(7);
  } finally {
    await sink.close();
  }
});

test("automatic log flushing emits completed minutes and close flushes the current minute", async () => {
  let now = Date.parse(at);
  const lines: string[] = [];
  const flushed = gate();
  const sink = new LogUsageSink({
    now: () => now,
    flushIntervalMs: 5,
    logger: (line) => {
      lines.push(line);
      flushed.resolve();
    },
  });
  sink.record(event());
  now += 60_000;
  await flushed.promise;
  expect(lines).toHaveLength(1);
  sink.record({ ...event(), at: new Date(now).toISOString() });
  await sink.close();
  expect(lines).toHaveLength(2);
  sink.record(event());
  await sink.flush();
  expect(lines).toHaveLength(2);
});

test("log aggregation is bounded, splits large totals and isolates malformed events and logger failures", async () => {
  const lines: string[] = [];
  const sink = new LogUsageSink({ maxAggregates: 2, logger: (line) => lines.push(line) });
  sink.record(event("blob_bytes", MAX_USAGE_AMOUNT - 1));
  sink.record(event("blob_bytes", 3));
  for (let i = 0; i < 1000; i++) sink.record({ ...event(), subject: `subject-${i}` });
  await sink.close();
  expect(decode(lines).map((row) => row.amount)).toEqual([MAX_USAGE_AMOUNT, 2]);
  const failing = new LogUsageSink({
    logger: () => {
      throw new Error("unsafe logger failure");
    },
  });
  for (const item of [
    null,
    undefined,
    { ...event(), ip: "192.0.2.1" },
    { ...event(), amount: Number.NaN },
    { ...event(), at: "invalid" },
    { ...event(), amount: 0 },
    { ...event(), amount: -1 },
    { ...event(), kind: "secret" },
  ])
    expect(() => failing.record(item as UsageEvent)).not.toThrow();
  failing.record(event());
  await expect(failing.close()).resolves.toBeUndefined();
});

test("HTTP posts bare arrays with every kind, authentication and strict 100-event batches", async () => {
  const bodies: UsageEvent[][] = [];
  const sink = new HttpUsageSink({
    url,
    token,
    fetch: async (input, init) => {
      expect(input).toBe(url);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    },
  });
  const kinds = ["session_created", "message", "blob_bytes", "throttled"] as const;
  for (let i = 0; i < 205; i++) sink.record(event(kinds[i % kinds.length]));
  expect(bodies).toEqual([]);
  await sink.close();
  expect(bodies.map((batch) => batch.length)).toEqual([100, 100, 5]);
  expect(new Set(bodies.flat().map((item) => item.kind))).toEqual(new Set(kinds));
});

test("HTTP batches obey encoded UTF-8 size and split amounts without losing sanitized data", async () => {
  const bodies: UsageEvent[][] = [];
  const sink = new HttpUsageSink({
    url,
    token,
    fetch: async (_, init) => {
      const body = String(init?.body);
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(32768);
      expect(body).not.toContain("extra-secret");
      bodies.push(JSON.parse(body));
      return new Response(null, { status: 204 });
    },
  });
  for (let i = 0; i < 25; i++)
    sink.record({ ...event(), subject: "😀".repeat(500), tier: "é".repeat(500) });
  const extra = { ...event("blob_bytes", MAX_USAGE_AMOUNT + 5), secret: "extra-secret" };
  sink.record(extra);
  extra.amount = 1;
  await sink.close();
  expect(bodies.length).toBeGreaterThan(1);
  expect(bodies.flat()).toHaveLength(27);
  expect(
    bodies
      .flat()
      .filter((item) => item.kind === "blob_bytes")
      .map((item) => item.amount),
  ).toEqual([MAX_USAGE_AMOUNT, 5]);
});

test("HTTP queue stays bounded while one delivery blocks and concurrent flushes share one worker", async () => {
  const entered = gate();
  const release = gate();
  const batches: UsageEvent[][] = [];
  const diagnostics: string[] = [];
  let pending = 0;
  let peak = 0;
  const sink = new HttpUsageSink({
    url,
    token,
    maxQueuedEvents: 3,
    logger: (line) => diagnostics.push(line),
    fetch: async (_, init) => {
      pending++;
      peak = Math.max(peak, pending);
      batches.push(JSON.parse(String(init?.body)));
      entered.resolve();
      await release.promise;
      pending--;
      return new Response(null, { status: 200 });
    },
  });
  for (let i = 0; i < 3; i++) sink.record(event());
  const flushing = sink.flush();
  await entered.promise;
  for (let i = 0; i < 10000; i++) sink.record(event());
  expect(sink.flush()).toBe(flushing);
  release.resolve();
  await flushing;
  await sink.close();
  expect(peak).toBe(1);
  expect(batches.map((batch) => batch.length)).toEqual([3, 3]);
  expect(diagnostics).toEqual(["remote-tab usage queue full; excess events dropped"]);
});

test("HTTP byte capacity bounds retained events separately from event count", async () => {
  const delivered: UsageEvent[] = [];
  const size = new TextEncoder().encode(JSON.stringify(event())).byteLength;
  const sink = new HttpUsageSink({
    url,
    token,
    maxQueuedBytes: size * 2 - 1,
    logger: () => {},
    fetch: async (_, init) => {
      delivered.push(...JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    },
  });
  for (let i = 0; i < 10000; i++) sink.record(event());
  await sink.close();
  expect(delivered).toHaveLength(1);
});

test("HTTP failures never retry ambiguous POSTs or log payloads, URLs, tokens or transport errors", async () => {
  for (const failure of ["status", "throw"] as const) {
    const diagnostics: string[] = [];
    let calls = 0;
    const sink = new HttpUsageSink({
      url,
      token,
      logger: (line) => diagnostics.push(line),
      fetch: async () => {
        calls++;
        if (failure === "throw") throw new Error(`${token} ${url} private payload`);
        return new Response(`${token} ${url} private payload`, { status: 503 });
      },
    });
    sink.record(event());
    await sink.flush();
    await sink.flush();
    await sink.close();
    expect(calls).toBe(1);
    expect(diagnostics).toEqual(["remote-tab usage delivery failed"]);
  }
});

test("HTTP timeout aborts promptly, and a transport ignoring abort cannot create unbounded concurrent requests", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const diagnostics: string[] = [];
  const sink = new HttpUsageSink({
    url,
    token,
    timeoutMs: 10,
    maxQueuedEvents: 150,
    logger: (line) => diagnostics.push(line),
    fetch: async (_, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    },
  });
  for (let i = 0; i < 150; i++) sink.record(event());
  await sink.flush();
  expect(signal?.aborted).toBe(true);
  for (let i = 0; i < 10000; i++) sink.record(event());
  await sink.flush();
  await sink.close();
  expect(calls).toBe(1);
  expect(diagnostics).toEqual([
    "remote-tab usage delivery failed",
    "remote-tab usage queue full; excess events dropped",
  ]);
});

test("sink setup rejects unsafe URLs and invalid bounds without reflecting secrets", () => {
  for (const invalid of [
    "https://user:password@usage.test",
    "https://usage.test/?key=private",
    "https://usage.test/#private",
    "http://outside.test",
    "invalid-private-url",
  ])
    expect(() => new HttpUsageSink({ url: invalid, token })).toThrow(
      /usage service URL|Usage service URL/,
    );
  expect(() => new HttpUsageSink({ url, token: "" })).toThrow("token is required");
  expect(() => new HttpUsageSink({ url, token, maxQueuedEvents: 0 })).toThrow(
    "positive safe integer",
  );
  expect(() => new LogUsageSink({ maxAggregates: -1 })).toThrow("positive safe integer");
});
