import { describe, expect, test } from "bun:test";
import { type Envelope, LIMITS, parseCode } from "@remote-tab/protocol";
import {
  deriveSessionId,
  deriveSessionKey,
  messageAad,
  randomSecret,
  seal,
} from "@remote-tab/protocol/src/crypto";
import { createApp } from "../../server/src/app";
import { StaticKeyResolver } from "../../server/src/key-resolver";
import { MemoryStore } from "../../server/src/memory-store";
import {
  AgentSession,
  BrowserPeer,
  type ClientOptions,
  type Fetch,
  type Hello,
  createSession,
} from "./index";

const serverUrl = "http://remote-tab.test";
const apiKey = "test-api-key";
const hello: Hello = {
  mode: "act",
  scope: null,
  title: "Example",
  url: "https://example.test",
  extension_version: "test",
};
const quick = { pollWaitSeconds: 0, pollIntervalMs: 1, timeoutMs: 2_000 };
function setup(now?: () => number) {
  const store = new MemoryStore(now ? () => new Date(now()) : undefined);
  const app = createApp({
    store,
    keyResolver: new StaticKeyResolver(new Map([["test", apiKey]]), { defaultQps: 0 }),
    anonymousQps: 0,
    now: now ? () => new Date(now()) : undefined,
  });
  const fetch: Fetch = (req) => app.fetch(req);
  return { store, fetch };
}
async function pair(options: ClientOptions = {}) {
  const h = setup();
  const opts = { ...quick, fetch: h.fetch, ...options };
  const { code, session } = await createSession({ serverUrl, apiKey, ...opts });
  const browser = await BrowserPeer.redeem({ serverUrl, code, hello, ...opts });
  return { ...h, code, session, browser, opts };
}
async function rawAppend(
  fetch: Fetch,
  id: string,
  token: string,
  secret: string,
  envelope: Envelope,
  role: "agent" | "browser" = "browser",
) {
  const status = await (
    await fetch(
      new Request(`${serverUrl}/v1/sessions/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
  ).json();
  const encrypted = await seal(
    await deriveSessionKey(secret, id),
    envelope,
    messageAad(id, role, status.last_hash),
  );
  return fetch(
    new Request(`${serverUrl}/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ role, prev_hash: status.last_hash, ...encrypted }),
    }),
  );
}

describe("client lifecycle", () => {
  test("status details recover authenticated consent after resume and stop without waiting or fetching blobs", async () => {
    const h = setup();
    const opts = { fetch: h.fetch, ...quick };
    const { code, session } = await createSession({ serverUrl, apiKey, ...opts });
    expect(await session.statusDetails()).toMatchObject({ state: "created" });
    expect((await session.statusDetails()).hello).toBeUndefined();
    const browser = await BrowserPeer.redeem({ serverUrl, code, hello, ...opts });
    expect(await AgentSession.resume(session.exportState(), opts).statusDetails()).toMatchObject({
      state: "active",
      hello,
    });
    const pending = session.send("browser_take_screenshot");
    const command = await browser.nextCommand();
    await browser.sendResult(
      command.id,
      {},
      { screenshot: { bytes: new Uint8Array([1]), mimeType: "image/png" } },
    );
    await pending;
    await session.stop();
    const requests: string[] = [];
    const fetch: Fetch = (request) => {
      requests.push(new URL(request.url).pathname);
      return h.fetch(request);
    };
    const details = await AgentSession.resume(session.exportState(), {
      ...quick,
      fetch,
    }).statusDetails();
    expect(details).toMatchObject({ state: "stopped", hello });
    expect(requests.some((path) => path.includes("/blobs/"))).toBe(false);
    const corrupt: Fetch = async (request) => {
      const response = await h.fetch(request);
      if (!new URL(request.url).pathname.endsWith("/messages")) return response;
      const body = await response.json();
      body.messages[0].hash = "f".repeat(64);
      return Response.json(body);
    };
    await expect(
      AgentSession.resume(session.exportState(), { ...quick, fetch: corrupt }).statusDetails(),
    ).rejects.toMatchObject({ code: "chain_invalid" });
  });

  test("status details reject authenticated but invalid first hello", async () => {
    const h = setup();
    const { session } = await createSession({ serverUrl, apiKey, fetch: h.fetch, ...quick });
    const state = session.exportState();
    // Redeem before appending a correctly encrypted, malformed browser hello.
    const redeemed = await h.fetch(
      new Request(`${serverUrl}/v1/sessions/${state.sessionId}/redeem`, { method: "POST" }),
    );
    const { browser_token } = await redeemed.json();
    await rawAppend(h.fetch, state.sessionId, browser_token, state.secret, {
      v: 1,
      kind: "hello",
      id: "invalid-hello",
      body: { mode: "invalid", scope: null },
    });
    await expect(session.statusDetails()).rejects.toMatchObject({ code: "protocol_invalid" });
  });

  test("cached authenticated status bypasses a blocked command poll", async () => {
    const { session, fetch } = await pair();
    let blockMessages = false;
    let reached: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = AgentSession.resume(session.exportState(), {
      ...quick,
      fetch: (request) => {
        if (blockMessages && new URL(request.url).pathname.endsWith("/messages")) {
          reached?.();
          return new Promise<Response>(() => {});
        }
        return fetch(request);
      },
    });
    await resumed.waitReady();
    blockMessages = true;
    const pending = resumed
      .send("browser_snapshot", {}, { timeoutMs: 150 })
      .catch((error) => error);
    await blocked;
    expect(await resumed.statusDetails({ timeoutMs: 50 })).toMatchObject({
      state: "active",
      hello,
    });
    expect(await pending).toMatchObject({ code: "timeout" });
  });

  test("cached status rejects rollback and a conflicting same-sequence hash", async () => {
    const { session, fetch } = await pair();
    let rollback: "none" | "sequence" | "hash" = "none";
    const resumed = AgentSession.resume(session.exportState(), {
      ...quick,
      fetch: async (request) => {
        const response = await fetch(request);
        if (rollback === "none" || !request.url.endsWith(session.sessionId)) return response;
        const status = await response.json();
        if (rollback === "sequence") {
          status.last_seq = 0;
          status.last_hash = "";
        } else status.last_hash = "f".repeat(64);
        return Response.json(status);
      },
    });
    await resumed.waitReady();
    rollback = "sequence";
    await expect(resumed.statusDetails()).rejects.toMatchObject({ code: "chain_invalid" });
    rollback = "hash";
    await expect(resumed.statusDetails()).rejects.toMatchObject({ code: "chain_invalid" });
  });

  test("create, private delivery, ready, result correlation, screenshot, handoff, stop and ledger", async () => {
    const { code, session, browser } = await pair();
    expect(await deriveSessionId(parseCode(code)?.secret ?? "")).toBe(session.sessionId);
    expect(await session.waitReady()).toEqual(hello);
    const pending = session.send("browser_click", { ref: "e1" });
    const command = await browser.nextCommand();
    expect(command).toMatchObject({ kind: "command", tool: "browser_click", args: { ref: "e1" } });
    const png = new Uint8Array([137, 80, 78, 71, 1, 2]);
    const snapshot = new TextEncoder().encode("untrusted snapshot");
    await browser.sendResult(
      command.id,
      { clicked: true },
      {
        screenshot: { bytes: png, mimeType: "image/png" },
        blobs: [{ bytes: snapshot, mimeType: "text/plain" }],
      },
    );
    const result = await pending;
    expect(result).toMatchObject({ id: command.id, ok: true, result: { clicked: true } });
    expect(result.attachments.map((a) => a.bytes)).toEqual([png, snapshot]);
    let finished = false;
    const handoff = session.handoff("Finish sign-in").then(() => {
      finished = true;
    });
    const request = await browser.nextCommand();
    expect(request).toMatchObject({ kind: "handoff", message: "Finish sign-in" });
    expect(finished).toBe(false);
    await expect(browser.handoffDone("wrong")).rejects.toMatchObject({ code: "invalid" });
    await browser.handoffDone(request.id);
    await handoff;
    expect(finished).toBe(true);
    expect((await session.stop()).state).toBe("stopped");
    await expect(session.send("browser_snapshot")).rejects.toMatchObject({
      code: "session_not_active",
    });
    const ledger = await session.ledger();
    expect(ledger.entries.map((entry) => entry.envelope.kind)).toEqual([
      "hello",
      "command",
      "result",
      "handoff",
      "handoff_done",
    ]);
    expect(ledger.entries[2].attachments.map((a) => a.bytes)).toEqual([png, snapshot]);
    expect((await browser.ledger()).entries).toEqual(ledger.entries);
  });

  test("resuming re-verifies readiness, can continue commands, and does not serialize the API key", async () => {
    const { session, browser, opts } = await pair();
    const state = JSON.parse(JSON.stringify(session.exportState()));
    expect(JSON.stringify(state)).not.toContain(apiKey);
    const resumed = AgentSession.resume(state, opts);
    expect(await resumed.waitReady()).toEqual(hello);
    const result = resumed.send("browser_snapshot");
    const command = await browser.nextCommand();
    await browser.sendError(command.id, "paused", "human took over");
    expect(await result).toMatchObject({
      ok: false,
      error: { code: "paused", message: "human took over" },
    });
    await expect(browser.sendResult(command.id, {})).rejects.toMatchObject({ code: "invalid" });
  });

  test("never sends the shared secret to create or redeem; already_redeemed is distinct", async () => {
    const h = setup();
    const requests: string[] = [];
    const fetch: Fetch = async (req) => {
      requests.push(`${req.url} ${JSON.stringify([...req.headers])} ${await req.clone().text()}`);
      return h.fetch(req);
    };
    const { code, session } = await createSession({ serverUrl, apiKey, fetch, ...quick });
    await BrowserPeer.redeem({ serverUrl, code, hello, fetch, ...quick });
    await expect(
      BrowserPeer.redeem({ serverUrl, code, hello, fetch, ...quick }),
    ).rejects.toMatchObject({ code: "already_redeemed", status: 409 });
    expect(requests.join("\n")).not.toContain(session.exportState().secret);
  });

  test("redeemer with wrong secret causes hijack_suspected and terminal stop", async () => {
    const h = setup();
    const { code, session } = await createSession({ serverUrl, apiKey, fetch: h.fetch, ...quick });
    // The public id still permits an id-only attacker to redeem, but they cannot
    // authenticate hello without the secret. The short-code client derives its
    // own id, so model this attacker through the raw unauthenticated endpoint.
    const response = await h.fetch(
      new Request(`${serverUrl}/v1/sessions/${session.sessionId}/redeem`, { method: "POST" }),
    );
    const redeemed = await response.json();
    await rawAppend(h.fetch, session.sessionId, redeemed.browser_token, randomSecret(), {
      v: 1,
      kind: "hello",
      id: "forged",
      body: hello,
    });
    await expect(session.waitReady()).rejects.toMatchObject({ code: "hijack_suspected" });
    expect((await session.status()).state).toBe("stopped");
    expect(code).not.toContain(session.sessionId);
    await expect(session.send("browser_type", { text: "private" })).rejects.toMatchObject({
      code: "hijack_suspected",
    });
    expect((await h.store.listMessages(session.sessionId, 0, 200)).length).toBe(1);
  });

  test("silent id-only redeemer is stopped after bounded grace, created sessions sleep", async () => {
    const h = setup();
    let time = 0;
    let sleeps = 0;
    const options = {
      fetch: h.fetch,
      pollWaitSeconds: 0,
      pollIntervalMs: 10,
      helloGraceMs: 30,
      timeoutMs: 100,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
        sleeps++;
      },
    };
    const { session } = await createSession({ serverUrl, apiKey, ...options });
    await expect(session.waitReady({ timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    expect(sleeps).toBe(1);
    expect((await session.status()).state).toBe("created");
    await h.fetch(
      new Request(`${serverUrl}/v1/sessions/${session.sessionId}/redeem`, { method: "POST" }),
    );
    await expect(session.waitReady()).rejects.toMatchObject({ code: "hijack_suspected" });
    expect(time).toBe(60);
    expect((await session.status()).state).toBe("stopped");
  });

  test("unredeemed readiness polls status at most once per second without fetching messages", async () => {
    const h = setup();
    let time = 0;
    const reads: { path: string; time: number }[] = [];
    const fetch: Fetch = (request) => {
      if (request.method === "GET") reads.push({ path: new URL(request.url).pathname, time });
      return h.fetch(request);
    };
    const { session } = await createSession({
      serverUrl,
      apiKey,
      fetch,
      pollIntervalMs: 1,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    await expect(session.waitReady({ timeoutMs: 2500 })).rejects.toMatchObject({ code: "timeout" });
    expect(reads.map((read) => read.time)).toEqual([0, 1000, 2000]);
    expect(reads.every((read) => read.path.endsWith(session.sessionId))).toBe(true);
    expect(time).toBe(2500);
  });

  test("aborting readiness during its one-second backoff stops promptly", async () => {
    const h = setup();
    const controller = new AbortController();
    let sleeps = 0;
    const { session } = await createSession({
      serverUrl,
      apiKey,
      fetch: h.fetch,
      sleep: async (ms) => {
        expect(ms).toBe(1000);
        sleeps++;
        controller.abort();
        await new Promise<void>(() => {});
      },
    });
    await expect(session.waitReady({ signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(sleeps).toBe(1);
  });

  test("full-code theft can produce valid hello, which does not authenticate human identity", async () => {
    const { session } = await pair();
    expect(await session.waitReady()).toEqual(hello);
  });

  test("client and browser timeouts leave the active session available", async () => {
    const { session, browser } = await pair();
    const pending = session.send("browser_snapshot", {}, { timeoutMs: 30 });
    const failed = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await browser.nextCommand();
    await failed;
    await expect(browser.nextCommand({ timeoutMs: 15 })).rejects.toMatchObject({ code: "timeout" });
    expect((await session.status()).state).toBe("active");
  });

  test("stop from browser wakes agent; already committed result is consumed before terminal status", async () => {
    const { session, browser } = await pair();
    const pending = session.send("browser_snapshot");
    const command = await browser.nextCommand();
    await browser.sendResult(command.id, { text: "last result" });
    await browser.stop();
    expect(await pending).toMatchObject({ ok: true, result: { text: "last result" } });
    expect((await session.status()).state).toBe("stopped");
    await expect(browser.nextCommand()).rejects.toMatchObject({ code: "session_not_active" });
  });

  test("expiry blocks commands but still allows authenticated ledger and blob reads", async () => {
    let now = Date.now();
    const h = setup(() => now);
    const options = { fetch: h.fetch, ...quick };
    const { code, session } = await createSession({ serverUrl, apiKey, ttl: 60, ...options });
    const browser = await BrowserPeer.redeem({ serverUrl, code, hello, ...options });
    const pending = session.send("browser_take_screenshot");
    const command = await browser.nextCommand();
    const bytes = new Uint8Array([1, 2, 3]);
    await browser.sendResult(command.id, {}, { screenshot: { bytes, mimeType: "image/png" } });
    await pending;
    now += 61_000;
    expect((await session.status()).state).toBe("expired");
    await expect(session.send("browser_snapshot")).rejects.toMatchObject({
      code: "session_not_active",
    });
    expect((await session.ledger()).entries[2].attachments[0].bytes).toEqual(bytes);
  });

  test("timed-out handoff survives resume and gates further commands until done", async () => {
    const { session, browser, opts } = await pair();
    const handoff = session.handoff("Your turn", { timeoutMs: 30 });
    const failed = expect(handoff).rejects.toMatchObject({ code: "timeout" });
    const request = await browser.nextCommand();
    await failed;
    const resumed = AgentSession.resume(session.exportState(), opts);
    await expect(resumed.send("browser_click", { ref: "e1" })).rejects.toMatchObject({
      code: "handoff_pending",
    });
    const finishing = resumed.handoff("resume existing handoff");
    await browser.handoffDone(request.id);
    await finishing;
    expect(
      (await resumed.ledger()).entries.filter((entry) => entry.envelope.kind === "handoff"),
    ).toHaveLength(1);
  });

  test("browser enforces handoff gate even against direct encrypted commands", async () => {
    const { session, browser, fetch } = await pair();
    const state = session.exportState();
    await rawAppend(
      fetch,
      state.sessionId,
      state.agentToken,
      state.secret,
      { v: 1, kind: "handoff", id: "handoff", body: { message: "Wait" } },
      "agent",
    );
    expect((await browser.nextCommand()).kind).toBe("handoff");
    await rawAppend(
      fetch,
      state.sessionId,
      state.agentToken,
      state.secret,
      { v: 1, kind: "command", id: "queued", body: { tool: "browser_click", args: { ref: "e1" } } },
      "agent",
    );
    await expect(browser.nextCommand({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    await browser.handoffDone("handoff");
    expect(await browser.nextCommand()).toMatchObject({ id: "queued", kind: "command" });
  });

  test("message and ciphertext blob size limits are checked locally", async () => {
    const { session, browser } = await pair();
    await expect(
      session.send("browser_type", { text: "x".repeat(LIMITS.messageMaxBytes) }),
    ).rejects.toMatchObject({ code: "too_large" });
    const pending = session.send("browser_snapshot");
    const command = await browser.nextCommand();
    await expect(
      browser.sendResult(
        command.id,
        {},
        { screenshot: { bytes: new Uint8Array(LIMITS.blobMaxBytes), mimeType: "image/png" } },
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    await browser.sendError(command.id, "too_large", "snapshot too large");
    expect((await pending).ok).toBe(false);
  });
});

describe("concurrency and HTTP bounds", () => {
  test("one chain race refreshes, reseals message and blobs, then correlates only requested result", async () => {
    const h = setup();
    const created = await createSession({ serverUrl, apiKey, fetch: h.fetch, ...quick });
    const state = created.session.exportState();
    let race = false;
    const attempts: Array<{ nonce: string; ciphertext: string; prev_hash: string }> = [];
    const fetch: Fetch = async (req) => {
      if (race && req.method === "POST" && new URL(req.url).pathname.endsWith("/messages")) {
        attempts.push(await req.clone().json());
        if (attempts.length === 1) {
          const token = req.headers.get("authorization")?.slice(7) as string;
          const res = await rawAppend(h.fetch, state.sessionId, token, state.secret, {
            v: 1,
            kind: "result",
            id: "unrelated",
            body: { ok: true, result: "wrong correlation" },
          });
          expect(res.status).toBe(201);
        }
      }
      return h.fetch(req);
    };
    const browser = await BrowserPeer.redeem({
      serverUrl,
      code: created.code,
      hello,
      fetch,
      ...quick,
    });
    const pending = created.session.send("browser_snapshot");
    const command = await browser.nextCommand();
    race = true;
    const bytes = new Uint8Array([4, 5, 6]);
    await browser.sendResult(command.id, "correct correlation", {
      screenshot: { bytes, mimeType: "image/png" },
    });
    const result = await pending;
    expect(result.result).toBe("correct correlation");
    expect(result.attachments[0].bytes).toEqual(bytes);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].prev_hash).not.toBe(attempts[1].prev_hash);
    expect(attempts[0].nonce).not.toBe(attempts[1].nonce);
    expect(attempts[0].ciphertext).not.toBe(attempts[1].ciphertext);
  });

  test("second chain mismatch is surfaced without unbounded retries", async () => {
    const h = setup();
    let conflicts = false;
    let attempts = 0;
    const fetch: Fetch = async (req) => {
      if (conflicts && req.method === "POST" && new URL(req.url).pathname.endsWith("/messages")) {
        attempts++;
        return Response.json({ error: "chain_mismatch", message: "raced" }, { status: 409 });
      }
      return h.fetch(req);
    };
    const { code, session } = await createSession({ serverUrl, apiKey, fetch, ...quick });
    await BrowserPeer.redeem({ serverUrl, code, hello, fetch: h.fetch, ...quick });
    conflicts = true;
    await expect(session.send("browser_snapshot")).rejects.toMatchObject({
      code: "chain_mismatch",
    });
    expect(attempts).toBe(2);
  });

  test("hung transport obeys short readiness timeout and abort cancels its Request", async () => {
    const { session } = await pair();
    let observed: AbortSignal | undefined;
    const fetch: Fetch = (req) => {
      observed = req.signal;
      return new Promise(() => {});
    };
    const resumed = AgentSession.resume(session.exportState(), { fetch, requestTimeoutMs: 10_000 });
    await expect(resumed.waitReady({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    expect(observed?.aborted).toBe(true);
    const controller = new AbortController();
    const pending = resumed.waitReady({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(observed?.aborted).toBe(true);
  });
});

test("HTTP timeout covers a stalled response body", async () => {
  const { session } = await pair();
  const resumed = AgentSession.resume(session.exportState(), {
    fetch: async () => new Response(new ReadableStream({ start() {} })),
    requestTimeoutMs: 10_000,
  });
  await expect(resumed.waitReady({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
});

test("stop bypasses a pending long-poll and terminates both waiters promptly", async () => {
  const { session, browser } = await pair({ pollWaitSeconds: 2 });
  const pending = session.send("browser_snapshot");
  const command = await browser.nextCommand();
  expect(command.kind).toBe("command");
  // Let send enter its long poll before stopping from that same client instance.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const observed = pending.catch((error) => error);
  const started = Date.now();
  expect((await session.stop()).state).toBe("stopped");
  expect(Date.now() - started).toBeLessThan(500);
  expect(await observed).toMatchObject({ code: "session_not_active" });
});

test("idle stop never waits for message persistence or additional status reads", async () => {
  const { session, fetch } = await pair();
  const requests: string[] = [];
  const resumed = AgentSession.resume(session.exportState(), {
    requestTimeoutMs: 150,
    fetch: async (request) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      if (!new URL(request.url).pathname.endsWith("/stop")) return new Promise<Response>(() => {});
      return fetch(request);
    },
  });
  const started = Date.now();
  expect((await resumed.stop()).state).toBe("stopped");
  expect(Date.now() - started).toBeLessThan(100);
  expect(requests).toEqual([`POST /v1/sessions/${session.sessionId}/stop`]);
  expect((await session.status()).state).toBe("stopped");
});

test("abort interrupts the actual server long-poll", async () => {
  const { session, browser } = await pair({ pollWaitSeconds: 2 });
  const controller = new AbortController();
  const pending = session.send("browser_snapshot", {}, { signal: controller.signal });
  await browser.nextCommand();
  const observed = pending.catch((error) => error);
  setTimeout(() => controller.abort(), 10);
  expect(await observed).toMatchObject({ code: "aborted" });
  expect((await session.status()).state).toBe("active");
  await browser.stop();
});

test("browser refuses a queued command when stop occurs between status and message read", async () => {
  const h = setup();
  const { code, session } = await createSession({ serverUrl, apiKey, fetch: h.fetch, ...quick });
  let stopOnRead = false;
  const fetch: Fetch = async (req) => {
    if (stopOnRead && req.method === "GET" && new URL(req.url).pathname.endsWith("/messages")) {
      await h.fetch(
        new Request(`${serverUrl}/v1/sessions/${session.sessionId}/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.exportState().agentToken}` },
        }),
      );
    }
    return h.fetch(req);
  };
  const browser = await BrowserPeer.redeem({ serverUrl, code, hello, fetch, ...quick });
  const state = session.exportState();
  await rawAppend(
    h.fetch,
    state.sessionId,
    state.agentToken,
    state.secret,
    {
      v: 1,
      kind: "command",
      id: "never-execute",
      body: { tool: "browser_click", args: { ref: "e1" } },
    },
    "agent",
  );
  stopOnRead = true;
  await expect(browser.nextCommand()).rejects.toMatchObject({ code: "session_not_active" });
});
