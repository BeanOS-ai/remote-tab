import { describe, expect, test } from "bun:test";
import type { CreateSessionResponse } from "@remote-tab/protocol";
import { type AppOptions, createApp } from "./app";
import { DEFAULT_THROTTLES, clientIp, parseThrottleEnv } from "./limits";
import { MemoryStore } from "./memory-store";

const API_KEY = "throttle-test-platform-key";
const IP_A = "192.0.2.1";
const IP_B = "192.0.2.2";
const START = Date.parse("2030-01-01T00:00:00Z");

function harness(options: Omit<AppOptions, "store" | "now"> = {}) {
  let time = START;
  const store = new MemoryStore();
  const app = createApp({ ...options, store, now: () => new Date(time) });
  const call = (
    path: string,
    init: RequestInit = {},
    token?: string,
    ip = IP_A,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return app.fetch(new Request(`http://rt.test${path}`, { ...init, headers }), {
      requestIP: () => ({ address: ip }),
    });
  };
  const create = (ip = IP_A, token?: string, forwarded?: string, ttl = 60) =>
    call(
      "/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ ttl_seconds: ttl }),
        headers: forwarded ? { "x-forwarded-for": forwarded } : undefined,
      },
      token,
      ip,
    );
  return {
    call,
    create,
    store,
    setTime: (ms: number) => {
      time = ms;
    },
  };
}

async function created(response: Response): Promise<CreateSessionResponse> {
  expect(response.status).toBe(201);
  return response.json();
}

async function limited(response: Response, retryAfter?: number) {
  expect(response.status).toBe(429);
  expect((await response.json()).error).toBe("rate_limited");
  expect(response.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
  if (retryAfter !== undefined) expect(response.headers.get("retry-after")).toBe(`${retryAfter}`);
}

async function active(h: ReturnType<typeof harness>) {
  const session = await created(await h.create());
  const redeemed = await h.call(`/v1/sessions/${session.id}/redeem`, { method: "POST" });
  expect(redeemed.status).toBe(200);
  const { browser_token } = await redeemed.json();
  return { ...session, browser_token: browser_token as string };
}

describe("creation authentication modes", () => {
  for (const apiKeys of [undefined, new Map<string, string>()]) {
    test(`open mode with ${apiKeys ? "empty" : "omitted"} keys accepts absent and arbitrary bearer`, async () => {
      const h = harness({ apiKeys });
      await created(await h.create());
      await created(await h.create(IP_A, "unregistered-key"));
    });
  }

  test("configured keys reject missing and incorrect credentials without consuming quota", async () => {
    const h = harness({
      apiKeys: new Map([["test", API_KEY]]),
      limits: { createPerMinute: 1 },
    });
    for (const token of [undefined, "incorrect-key"]) {
      const response = await h.create(IP_A, token);
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("unauthorized");
    }
    await created(await h.create(IP_A, API_KEY));
  });
});

for (const mode of ["open", "keyed"] as const) {
  describe(`${mode} mode quotas`, () => {
    const apiKeys = mode === "keyed" ? new Map([["test", API_KEY]]) : undefined;
    const token = mode === "keyed" ? API_KEY : undefined;

    test("create rate is per IP and recovers exactly at the minute boundary", async () => {
      const h = harness({ apiKeys, limits: { createPerMinute: 2 } });
      const burst = await Promise.all([h.create(IP_A, token), h.create(IP_A, token)]);
      for (const response of burst) await created(response);
      await limited(await h.create(IP_A, token), 60);
      await created(await h.create(IP_B, token));
      h.setTime(START + 59_999);
      await limited(await h.create(IP_A, token), 1);
      h.setTime(START + 60_000);
      await created(await h.create(IP_A, token));
      await created(await h.create(IP_A, token));
      await limited(await h.create(IP_A, token), 60);
    });

    test("unredeemed sessions consume per-IP capacity until stopped or expired", async () => {
      const h = harness({
        apiKeys,
        limits: { createPerMinute: 100, activePerIp: 1, activeMax: 10 },
      });
      const first = await created(await h.create(IP_A, token));
      await limited(await h.create(IP_A, token));
      await created(await h.create(IP_B, token));
      expect(
        (await h.call(`/v1/sessions/${first.id}/stop`, { method: "POST" }, first.agent_token))
          .status,
      ).toBe(200);
      await created(await h.create(IP_A, token));
      h.setTime(START + 59_999);
      await limited(await h.create(IP_A, token));
      h.setTime(START + 60_000);
      await created(await h.create(IP_A, token));
    });

    test("global capacity spans IPs and admits only one concurrent contender", async () => {
      const h = harness({
        apiKeys,
        limits: { createPerMinute: 100, activePerIp: 10, activeMax: 1 },
      });
      const responses = await Promise.all([h.create(IP_A, token), h.create(IP_B, token)]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
      const winner = await created(responses.find((r) => r.status === 201) as Response);
      await limited(responses.find((r) => r.status === 429) as Response);
      expect(
        (await h.call(`/v1/sessions/${winner.id}/stop`, { method: "POST" }, winner.agent_token))
          .status,
      ).toBe(200);
      await created(await h.create(IP_B, token));
      await limited(await h.create(IP_A, token));
      h.setTime(START + 60_000);
      await created(await h.create(IP_A, token));
    });
  });
}

describe("session resource budgets", () => {
  test("blob byte budget sums uploads across both roles, permits equality, and rejects excess", async () => {
    const h = harness({ limits: { blobBudgetBytes: 7 }, blobMaxBytes: 6 });
    const session = await active(h);
    const upload = (body: string, token: string) =>
      h.call(`/v1/sessions/${session.id}/blobs`, { method: "POST", body }, token);
    const first = await upload("abc", session.agent_token);
    expect(first.status).toBe(201);
    const { blob_id } = await first.json();
    expect((await upload("defg", session.browser_token)).status).toBe(201);
    await limited(await upload("h", session.agent_token));
    const saved = await h.call(
      `/v1/sessions/${session.id}/blobs/${blob_id}`,
      {},
      session.browser_token,
    );
    expect(await saved.text()).toBe("abc");
    expect((await h.store.getSession(session.id))?.blobBytes).toBe(7);
    const other = await active(h);
    expect(
      (
        await h.call(
          `/v1/sessions/${other.id}/blobs`,
          { method: "POST", body: "abcdef" },
          other.agent_token,
        )
      ).status,
    ).toBe(201);
  });

  test("concurrent uploads cannot overspend the remaining blob budget", async () => {
    const h = harness({ limits: { blobBudgetBytes: 5 } });
    const session = await active(h);
    const responses = await Promise.all(
      [session.agent_token, session.browser_token].map((token) =>
        h.call(`/v1/sessions/${session.id}/blobs`, { method: "POST", body: "abcd" }, token),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
    await limited(responses.find((r) => r.status === 429) as Response);
    expect((await h.store.getSession(session.id))?.blobBytes).toBe(4);
  });

  test("message cap spans both roles without advancing the chain on refusal", async () => {
    const h = harness({ limits: { messagesMax: 2 } });
    const session = await active(h);
    const append = (role: "agent" | "browser", prev_hash: string) =>
      h.call(
        `/v1/sessions/${session.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            role,
            prev_hash,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "Y2lwaGVydGV4dC1ieXRlcy1oZXJl",
          }),
        },
        role === "agent" ? session.agent_token : session.browser_token,
      );
    const first = await append("agent", "");
    expect(first.status).toBe(201);
    const second = await append("browser", (await first.json()).hash);
    expect(second.status).toBe(201);
    const head = await second.json();
    await limited(await append("agent", head.hash));
    const status = await h.call(`/v1/sessions/${session.id}`, {}, session.agent_token);
    expect(await status.json()).toMatchObject({ last_seq: 2, last_hash: head.hash });
    expect(await h.store.listMessages(session.id, 0, 10)).toHaveLength(2);
  });
});

describe("client IP trust and normalization", () => {
  test("changing forwarded headers cannot evade the default socket IP rate limit", async () => {
    const h = harness({ limits: { createPerMinute: 1 } });
    await created(await h.create(IP_A, undefined, IP_B));
    await limited(await h.create(IP_A, undefined, "192.0.2.3"));
    await created(await h.create(IP_B, undefined, IP_B));
  });

  test("trusted proxy mode uses only the first forwarded IP", async () => {
    const h = harness({ trustProxy: true, limits: { createPerMinute: 1 } });
    await created(await h.create("192.0.2.254", undefined, `${IP_A}, ${IP_B}`));
    await limited(await h.create("192.0.2.253", undefined, `${IP_A}, 192.0.2.3`));
    await created(await h.create("192.0.2.254", undefined, `${IP_B}, ${IP_A}`));
  });

  for (const [first, equivalent] of [
    ["2001:db8::1", "2001:0DB8:0000:0000:0000:0000:0000:0001"],
    [IP_A, "::ffff:192.0.2.1"],
    [IP_A, "::ffff:c000:201"],
  ]) {
    test(`${first} and ${equivalent} share a quota`, async () => {
      const h = harness({ limits: { createPerMinute: 1 } });
      await created(await h.create(first));
      await limited(await h.create(equivalent));
    });
  }

  test("invalid or absent forwarded IP falls back to the peer, or one unknown bucket", () => {
    const req = new Request("http://rt.test", {
      headers: { "x-forwarded-for": `invalid, ${IP_B}` },
    });
    expect(clientIp(req, IP_A, true)).toBe(IP_A);
    expect(clientIp(req, undefined, true)).toBe("unknown");
    expect(clientIp(new Request("http://rt.test"), IP_A, true)).toBe(IP_A);
    expect(clientIp(req, "invalid-peer", false)).toBe("unknown");
    const scoped = new Request("http://rt.test", {
      headers: { "x-forwarded-for": "fe80::1%eth0" },
    });
    expect(clientIp(scoped, IP_A, true)).toBe(IP_A);
    const mapped = new Request("http://rt.test", {
      headers: { "x-forwarded-for": "::ffff:192.0.2.1" },
    });
    expect(clientIp(mapped, IP_B, true)).toBe(IP_A);
  });
});

describe("throttle environment configuration", () => {
  const fields = {
    REMOTE_TAB_CREATE_PER_MINUTE: "createPerMinute",
    REMOTE_TAB_ACTIVE_PER_IP: "activePerIp",
    REMOTE_TAB_ACTIVE_MAX: "activeMax",
    REMOTE_TAB_BLOB_BUDGET_BYTES: "blobBudgetBytes",
    REMOTE_TAB_MESSAGES_MAX: "messagesMax",
  } as const;

  test("unset values use the documented defaults", () => {
    expect(parseThrottleEnv({})).toEqual({
      createPerMinute: 10,
      activePerIp: 20,
      activeMax: 500,
      blobBudgetBytes: 64 * 1024 * 1024,
      messagesMax: 5000,
    });
  });

  for (const [env, field] of Object.entries(fields)) {
    test(`${env} overrides only its setting and ignores empty values`, () => {
      expect(parseThrottleEnv({ [env]: "7" })).toEqual({ ...DEFAULT_THROTTLES, [field]: 7 });
      expect(parseThrottleEnv({ [env]: "  " })).toEqual(DEFAULT_THROTTLES);
    });

    test(`${env} rejects nonpositive, fractional, nonnumeric, and unsafe values`, () => {
      for (const value of [
        "0",
        "-1",
        "1.5",
        "not-a-number",
        "NaN",
        "Infinity",
        "9007199254740992",
      ]) {
        expect(() => parseThrottleEnv({ [env]: value })).toThrow(
          `${env} must be a positive safe integer`,
        );
      }
    });
  }
});
