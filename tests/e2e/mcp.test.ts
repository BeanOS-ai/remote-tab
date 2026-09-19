import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ClientOptions, type Fetch, PRIVATE_DELIVERY_WARNING } from "@remote-tab/client";
import { createMcpServer } from "@remote-tab/mcp";
import { parseCode } from "@remote-tab/protocol";
import { deriveSessionId } from "@remote-tab/protocol/src/crypto";
import { MemoryStore, createApp } from "@remote-tab/server";
import { FakeTab, HELLO, PNG, until } from "./fake-tab";

const serverUrl = "http://remote-tab.test";
const quick = { timeoutMs: 2000, pollWaitSeconds: 0, pollIntervalMs: 1 };
function payload(result: CallToolResult) {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("Expected JSON tool result");
  return JSON.parse(first.text);
}
async function fixture(options: ClientOptions = {}) {
  let now = Date.now();
  const app = createApp({
    store: new MemoryStore(),
    apiKeys: new Map([["e2e", "test-key"]]),
    now: () => new Date(now),
  });
  const fetch: Fetch = (request) => app.fetch(request);
  const server = createMcpServer({
    serverUrl,
    apiKey: "test-key",
    fetch,
    clientOptions: { ...quick, ...options },
  });
  const client = new Client({ name: "headless-e2e", version: "0.0.0" });
  const [agent, transport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(agent), server.connect(transport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    expect(result.isError).toBeUndefined();
    return payload(result);
  };
  return {
    list: () => client.listTools(),
    call,
    ok,
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("real MCP tools drive stateful fake tab, preserve PNGs and block for human Done", async () => {
  const h = await fixture();
  let tab: FakeTab | undefined;
  try {
    const created = await h.ok("remote_tab_create");
    expect(created.warning).toBe(PRIVATE_DELIVERY_WARNING);
    expect(created.code).toMatch(/^rt1\.[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(created.code).toHaveLength(26);
    tab = await FakeTab.redeem({ serverUrl, code: created.code, fetch: h.fetch, ...quick });
    await expect(
      FakeTab.redeem({ serverUrl, code: created.code, fetch: h.fetch, ...quick }),
    ).rejects.toMatchObject({ code: "already_redeemed" });
    expect(await h.ok("remote_tab_wait_ready")).toEqual(HELLO);
    const snapshot = await h.ok("browser_snapshot");
    const input = snapshot.result.nodes.find((node: { role: string }) => node.role === "textbox");
    const button = snapshot.result.nodes.find((node: { role: string }) => node.role === "button");
    for (const [tool, args] of [
      ["browser_type", { ref: input.ref, text: "Grace" }],
      ["browser_click", { ref: button.ref }],
      ["browser_take_screenshot", {}],
    ] as const) {
      const result = await h.call(tool, args);
      expect(result.isError).toBeUndefined();
      expect(result.content[1]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      });
    }
    const after = await h.ok("browser_snapshot");
    expect(after.result.nodes[0]).toMatchObject({ ref: input.ref, value: "Grace" });
    expect(after.result.nodes[2].text).toBe("Submitted: Grace");
    let handedBack = false;
    const handoff = h
      .call("remote_tab_handoff", { message: "Approve this change" })
      .then((result) => {
        handedBack = true;
        return result;
      });
    await until(() => tab?.handoffMessage === "Approve this change");
    const count = tab.executed.length;
    let followedUp = false;
    const next = h.call("browser_snapshot").then((result) => {
      followedUp = true;
      return result;
    });
    await Bun.sleep(30);
    expect(handedBack).toBe(false);
    expect(followedUp).toBe(false);
    expect(tab.executed.length).toBe(count);
    expect((await h.ok("remote_tab_status")).hello).toEqual(HELLO);
    await tab.done();
    expect((await handoff).isError).toBeUndefined();
    expect((await next).isError).toBeUndefined();
    expect(tab.executed.length).toBe(count + 1);
    expect((await h.ok("remote_tab_stop")).state).toBe("stopped");
    await until(() => tab?.terminal === "stopped");
    const denied = await h.call("browser_click", { ref: button.ref });
    expect(denied.isError).toBe(true);
    expect(payload(denied).error.code).toBe("session_not_active");
    expect(tab.executed.length).toBe(count + 1);
  } finally {
    try {
      await tab?.close();
    } finally {
      await h.close();
    }
  }
});

test("only browser can extend; extended session expires terminally with readable ledger", async () => {
  const h = await fixture();
  let tab: FakeTab | undefined;
  try {
    const created = await h.ok("remote_tab_create");
    tab = await FakeTab.redeem({ serverUrl, code: created.code, fetch: h.fetch, ...quick });
    await h.ok("remote_tab_wait_ready");
    const before = await h.ok("remote_tab_status");
    const extended = await tab.peer.extend();
    expect(Date.parse(extended.expires_at) - Date.parse(before.expires_at)).toBe(1800_000);
    await expect(tab.peer.extend()).rejects.toMatchObject({ code: "ttl_exceeded" });
    // The agent interface deliberately has no extension tool.
    expect((await h.list()).tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "remote_tab_extend",
    );
    h.advance(1801_000);
    expect((await h.ok("browser_snapshot")).result.nodes[0].ref).toBe("name");
    h.advance(1800_000);
    expect((await h.ok("remote_tab_status")).state).toBe("expired");
    const denied = await h.call("browser_type", { ref: "name", text: "too late" });
    expect(denied.isError).toBe(true);
    expect(payload(denied).error.code).toBe("session_not_active");
    await until(() => tab?.terminal === "expired");
    expect(tab.value).toBe("");
    expect((await tab.peer.ledger()).entries.map((entry) => entry.envelope.kind)).toEqual([
      "hello",
      "command",
      "result",
    ]);
  } finally {
    try {
      await tab?.close();
    } finally {
      await h.close();
    }
  }
});

test("secret-less redemption reports hijack suspicion, stops, and preserves already_redeemed distinction", async () => {
  const h = await fixture({ helloGraceMs: 10 });
  try {
    const created = await h.ok("remote_tab_create");
    const parsed = parseCode(created.code);
    expect(parsed).not.toBeNull();
    const response = await h.fetch(
      new Request(
        `${serverUrl}/v1/sessions/${await deriveSessionId(parsed?.secret ?? "")}/redeem`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(200);
    // The id-only redeemer never received the secret and cannot authenticate a hello.
    await expect(
      FakeTab.redeem({ serverUrl, code: created.code, fetch: h.fetch, ...quick }),
    ).rejects.toMatchObject({ code: "already_redeemed" });
    const readiness = await h.call("remote_tab_wait_ready", { timeoutMs: 1000 });
    expect(readiness.isError).toBe(true);
    expect(payload(readiness).error.code).toBe("hijack_suspected");
    const status = await h.ok("remote_tab_status");
    expect(status.state).toBe("stopped");
    expect(status.last_seq).toBe(0);
    expect(status.hello).toBeUndefined();
  } finally {
    await h.close();
  }
});
