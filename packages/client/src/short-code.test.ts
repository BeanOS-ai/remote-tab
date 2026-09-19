import { expect, test } from "bun:test";
import { SESSION_ID_RE, formatCode, parseCode } from "@remote-tab/protocol";
import { deriveSessionId } from "@remote-tab/protocol/src/crypto";
import { type AgentConnectionState, AgentSession, BrowserPeer, createSession } from "./index";

const serverUrl = "https://short-code.test";
const secret = "AAECAwQFBgcICQoLDA0ODw";
const sessionId = "7087407e1b71d177d2899a4cb6c7fb0b";
const hello = { mode: "read" as const, scope: null };
const state: AgentConnectionState = {
  v: 1,
  serverUrl,
  sessionId,
  secret,
  agentToken: "agent-token",
};

test("create derives the locator locally before POST and returns only the 26-character code", async () => {
  let posted: Record<string, unknown> = {};
  let wire = "";
  const { code, session } = await createSession({
    serverUrl,
    apiKey: "platform-key",
    ttl: 123,
    fetch: async (request) => {
      expect(request.url).toBe(`${serverUrl}/v1/sessions`);
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer platform-key");
      wire = await request.text();
      posted = JSON.parse(wire);
      expect(SESSION_ID_RE.test(String(posted.id))).toBe(true);
      expect(Object.keys(posted).sort()).toEqual(["id", "ttl_seconds"]);
      expect(posted.ttl_seconds).toBe(123);
      return Response.json(
        {
          id: posted.id,
          agent_token: "agent-token",
          expires_at: "2026-09-18T12:00:00Z",
          redeem_until: "2026-09-18T11:40:00Z",
        },
        { status: 201 },
      );
    },
  });
  expect(code.length).toBe(26);
  const parsed = parseCode(code);
  expect(parsed).toEqual({ secret: session.exportState().secret });
  expect(posted.id).toBe(await deriveSessionId(parsed?.secret ?? ""));
  expect(session.sessionId).toBe(String(posted.id));
  expect(wire).not.toContain(session.exportState().secret);
  expect(wire).not.toContain(code);
});

for (const id of ["f".repeat(32), "00000000-0000-4000-8000-000000000001", undefined]) {
  test(`create rejects substituted or missing session id (${id === undefined ? "missing" : id.length})`, async () => {
    let calls = 0;
    await expect(
      createSession({
        serverUrl,
        apiKey: "platform-key",
        fetch: async () => {
          calls++;
          return Response.json({ id, agent_token: "agent-token" }, { status: 201 });
        },
      }),
    ).rejects.toMatchObject({ code: "protocol_invalid" });
    expect(calls).toBe(1);
  });
}

test("create surfaces id_taken without retrying or silently switching identity", async () => {
  let calls = 0;
  await expect(
    createSession({
      serverUrl,
      apiKey: "platform-key",
      fetch: async () => {
        calls++;
        return Response.json(
          { error: "id_taken", message: "Session id already exists" },
          { status: 409 },
        );
      },
    }),
  ).rejects.toMatchObject({ code: "id_taken", status: 409 });
  expect(calls).toBe(1);
});

test("redeem sends only the derived id in the endpoint, never the code or secret", async () => {
  let calls = 0;
  await expect(
    BrowserPeer.redeem({
      serverUrl,
      code: formatCode(secret),
      hello,
      fetch: async (request) => {
        calls++;
        expect(request.url).toBe(`${serverUrl}/v1/sessions/${sessionId}/redeem`);
        expect(request.method).toBe("POST");
        expect(await request.text()).toBe("");
        expect(JSON.stringify([...request.headers])).not.toContain(secret);
        return Response.json({ error: "not_found", message: "Unknown session" }, { status: 404 });
      },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(calls).toBe(1);
});

test("legacy, padded and noncanonical codes are rejected before any redeem request", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const code of [
    `rt1.${sessionId}.${secret}`,
    `rt1.00000000-0000-4000-8000-000000000001.${"A".repeat(43)}`,
    `rt1.${"A".repeat(43)}`,
    `rt1.${secret}==`,
    `rt1.${"A".repeat(21)}B`,
  ])
    await expect(BrowserPeer.redeem({ serverUrl, code, hello, fetch })).rejects.toMatchObject({
      code: "invalid",
    });
  expect(calls).toBe(0);
});

test("resume remains synchronous but rejects inconsistent id/secret before status or ledger transport", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({});
  };
  const resumed = AgentSession.resume({ ...state, sessionId: "f".repeat(32) }, { fetch });
  expect(resumed).toBeInstanceOf(AgentSession);
  await expect(resumed.status()).rejects.toMatchObject({ code: "invalid" });
  await expect(resumed.ledger()).rejects.toMatchObject({ code: "invalid" });
  expect(calls).toBe(0);
  for (const invalid of [
    null,
    {},
    { ...state, sessionId: "00000000-0000-4000-8000-000000000001" },
    { ...state, secret: "A".repeat(43) },
    { ...state, secret: `${"A".repeat(21)}B` },
    { ...state, agentToken: "" },
  ])
    expect(() => AgentSession.resume(invalid as AgentConnectionState, { fetch })).toThrow(
      "Invalid private connection state",
    );
});

test("valid resumed identity is rechecked without changing its stored state", async () => {
  const resumed = AgentSession.resume(state, {
    fetch: async () =>
      Response.json({
        id: sessionId,
        state: "created",
        last_seq: 0,
        last_hash: "",
        expires_at: "2026-09-18T12:00:00Z",
        redeemed: false,
      }),
  });
  expect((await resumed.status()).id).toBe(sessionId);
  expect(resumed.exportState()).toEqual(state);
});
