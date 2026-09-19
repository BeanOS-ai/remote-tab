import { expect, test } from "bun:test";
import { AgentSession, createSession } from "./index";
import { jsonPost, request } from "./peer";

const url = "https://remote-tab.test/v1/sessions";
const limited = (retryAfter: string | null = "0", error = "rate_limited", status = 429) =>
  Response.json(
    { error, message: "Try later" },
    { status, headers: retryAfter === null ? {} : { "retry-after": retryAfter } },
  );

test("429 error envelopes have a separate allowance from the successful blob budget", async () => {
  for (const length of [3, 4]) {
    let calls = 0;
    const pending = request(
      async () => (++calls === 1 ? limited() : new Response(new Uint8Array(length).fill(42))),
      url,
      "browser-token",
      {},
      1000,
      3,
    );
    if (length === 3) {
      const response = await pending;
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([42, 42, 42]);
    } else await expect(pending).rejects.toMatchObject({ code: "ledger_too_large" });
    expect(calls).toBe(2);
  }
});

test("non-success bodies stay bounded even when successful responses have no byte cap", async () => {
  let calls = 0;
  let canceled = false;
  await expect(
    request(
      async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8193));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 429, headers: { "retry-after": "0" } },
        );
      },
      url,
      undefined,
    ),
  ).rejects.toMatchObject({ code: "ledger_too_large" });
  expect(calls).toBe(1);
  expect(canceled).toBe(true);
});

test("explicit 429 retries the same JSON write and bearer only after Retry-After", async () => {
  const attempts: { text: string; authorization: string | null; time: number }[] = [];
  const response = await request(
    async (req) => {
      attempts.push({
        text: await req.text(),
        authorization: req.headers.get("authorization"),
        time: performance.now(),
      });
      return attempts.length === 1 ? limited("1") : Response.json({ ok: true });
    },
    url,
    "role-token",
    jsonPost({ ciphertext: "unchanged" }),
    2000,
  );
  expect(await response.json()).toEqual({ ok: true });
  expect(attempts).toHaveLength(2);
  expect(attempts[0].text).toBe(attempts[1].text);
  expect(attempts.map((attempt) => attempt.authorization)).toEqual([
    "Bearer role-token",
    "Bearer role-token",
  ]);
  expect(attempts[1].time - attempts[0].time).toBeGreaterThanOrEqual(990);
});

test("retry snapshots mutable binary bodies before an asynchronous transport runs", async () => {
  const body = new Uint8Array([1, 2, 3]);
  const bodies: number[][] = [];
  await request(
    async (req) => {
      bodies.push(Array.from(new Uint8Array(await req.arrayBuffer())));
      body.fill(9);
      return bodies.length === 1 ? limited() : Response.json({ ok: true });
    },
    url,
    "browser-token",
    { method: "POST", body },
    1000,
  );
  expect(bodies).toEqual([
    [1, 2, 3],
    [1, 2, 3],
  ]);
});

test("HTTP-date Retry-After is accepted and malformed or absent hints never replay writes", async () => {
  let calls = 0;
  await request(
    async () =>
      ++calls === 1 ? limited(new Date(Date.now() - 1000).toUTCString()) : Response.json({}),
    url,
    undefined,
  );
  expect(calls).toBe(2);
  for (const header of [
    null,
    "bad",
    "0.1",
    "-1",
    "Infinity",
    "999999999999999999999999",
  ] as const) {
    let attempts = 0;
    await expect(
      request(
        async () => {
          attempts++;
          return limited(header);
        },
        url,
        undefined,
        jsonPost({ command: true }),
        50,
      ),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(attempts).toBe(1);
  }
});

test("server errors, different 429 errors and ambiguous network failures never replay writes", async () => {
  for (const response of [
    () => limited("0", "rate_limited", 503),
    () => limited("0", "unauthorized"),
    () => new Response("not JSON", { status: 429, headers: { "retry-after": "0" } }),
    () => {
      throw new Error("Acknowledgement lost after commit");
    },
  ]) {
    let calls = 0;
    await expect(
      request(
        async (req) => {
          calls++;
          await req.text();
          return response();
        },
        url,
        "agent-token",
        jsonPost({ command: "act once" }),
        50,
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  }
});

test("non-replayable stream writes surface 429 after one attempt", async () => {
  let calls = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([42]));
      controller.close();
    },
  });
  await expect(
    request(
      async (req) => {
        calls++;
        expect(Array.from(new Uint8Array(await req.arrayBuffer()))).toEqual([42]);
        return limited();
      },
      url,
      "agent-token",
      { method: "POST", body },
      50,
    ),
  ).rejects.toMatchObject({ code: "rate_limited" });
  expect(calls).toBe(1);
});

test("AbortSignal cancels backoff promptly and cannot start another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = request(
    async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return limited("1");
    },
    url,
    undefined,
    { signal: controller.signal },
    2000,
  );
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  await Bun.sleep(20);
  expect(calls).toBe(1);
  await expect(
    request(
      async () => {
        calls++;
        return Response.json({});
      },
      url,
      undefined,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(calls).toBe(1);
});

test("repeated zero-second 429s share one deadline and yield to cancellation timers", async () => {
  let calls = 0;
  const started = performance.now();
  await expect(
    request(
      async () => {
        calls++;
        return limited();
      },
      url,
      undefined,
      {},
      250,
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(calls).toBeGreaterThan(1);
  expect(performance.now() - started).toBeLessThan(2000);
  const completed = calls;
  await Bun.sleep(20);
  expect(calls).toBe(completed);
});

test("Retry-After beyond the remaining deadline preserves the original 429 without another attempt", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return limited("3600");
  };
  await expect(request(fetch, url, undefined, {}, 20)).rejects.toMatchObject({
    code: "rate_limited",
    status: 429,
  });
  expect(calls).toBe(1);
  const session = AgentSession.resume(
    {
      v: 1,
      serverUrl: "https://remote-tab.test",
      sessionId: "7087407e1b71d177d2899a4cb6c7fb0b",
      secret: "AAECAwQFBgcICQoLDA0ODw",
      agentToken: "agent-token",
    },
    { fetch, requestTimeoutMs: 30_000 },
  );
  await expect(session.waitReady({ timeoutMs: 20 })).rejects.toMatchObject({
    code: "rate_limited",
    status: 429,
  });
  expect(calls).toBe(2);
});

test("anonymous creation omits authorization across retries and later uses only its role token", async () => {
  const posts: string[] = [];
  const authorizations: (string | null)[] = [];
  let id = "";
  const { session, code } = await createSession({
    serverUrl: "https://remote-tab.test",
    fetch: async (req) => {
      authorizations.push(req.headers.get("authorization"));
      if (req.method === "POST") {
        posts.push(await req.text());
        id = JSON.parse(posts[0]).id;
        if (posts.length === 1) return limited();
        return Response.json({
          id,
          agent_token: "role-token",
          expires_at: "2026-10-01T00:00:00Z",
          redeem_until: "2026-10-01T00:00:00Z",
        });
      }
      return Response.json({
        id,
        state: "created",
        last_seq: 0,
        last_hash: "",
        redeemed: false,
        expires_at: "2026-10-01T00:00:00Z",
      });
    },
  });
  expect(code).toHaveLength(26);
  expect(posts).toHaveLength(2);
  expect(posts[0]).toBe(posts[1]);
  await session.status();
  expect(authorizations).toEqual([null, null, "Bearer role-token"]);
  expect(Object.keys(session.exportState()).sort()).toEqual([
    "agentToken",
    "secret",
    "serverUrl",
    "sessionId",
    "v",
  ]);
});
