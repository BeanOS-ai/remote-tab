import { expect, test } from "bun:test";
import { type Fetch, type Hello, createSession } from "@remote-tab/client";
import { MemoryStore, createApp } from "@remote-tab/server";
import { TabDriver } from "../../packages/extension/src/driver";
import { SharedSession } from "../../packages/extension/src/session";
import { StaticKeyResolver } from "../../packages/server/src/key-resolver";
import { PNG, until } from "./fake-tab";

const serverUrl = "http://remote-tab.test";
const quick = { timeoutMs: 2000, pollWaitSeconds: 0, pollIntervalMs: 1 };
const hello = {
  mode: "act",
  scope: "example.test",
  url: "https://example.test/form",
  title: "Extension form",
  extension_version: "2.0.1",
} satisfies Hello;

/** Only Chrome is doubled: real driver, session loop, crypto, client and server run. */
class FakeCdp {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  value = "";
  submitted = "";
  url = hello.url;
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", url: this.url } } };
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "root",
              role: { value: "RootWebArea" },
              name: { value: hello.title },
              childIds: ["input", "button", "status"],
            },
            {
              nodeId: "input",
              backendDOMNodeId: 10,
              role: { value: "textbox" },
              name: { value: "Name" },
              value: { value: this.value },
            },
            {
              nodeId: "button",
              backendDOMNodeId: 20,
              role: { value: "button" },
              name: { value: "Submit" },
            },
            {
              nodeId: "status",
              backendDOMNodeId: 30,
              role: { value: "status" },
              name: { value: this.submitted },
            },
          ],
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 1 };
      case "DOM.resolveNode":
        return { object: { objectId: `node-${params.backendNodeId}` } };
      case "Runtime.callFunctionOn": {
        const args = params.arguments as { value: unknown }[];
        if (args[0].value === "prepare") return { result: { value: { x: 60, y: 25, href: null } } };
        if (args[0].value === "type" && params.objectId === "node-10") {
          this.value = String(args[1].value);
          return { result: { value: { typed: true } } };
        }
        throw new Error("Unexpected node operation");
      }
      case "Input.dispatchMouseEvent":
        if (params.type === "mouseReleased") this.submitted = `Submitted: ${this.value}`;
        return {};
      case "Runtime.evaluate":
        return { result: { type: "number", value: 42 } };
      case "Page.captureScreenshot":
        return { data: Buffer.from(PNG).toString("base64") };
      case "Page.navigate":
        this.url = String(params.url);
        return { frameId: "main" };
      case "Page.enable":
      case "Runtime.enable":
      case "DOM.enable":
      case "Accessibility.enable":
      case "Log.enable":
      case "Page.setLifecycleEventsEnabled":
      case "Runtime.releaseObject":
      case "Network.enable":
      case "Fetch.enable":
      case "Input.dispatchKeyEvent":
      case "DOM.scrollIntoViewIfNeeded":
        return {};
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  }
}

async function fixture(mode: Hello["mode"] = "act") {
  const app = createApp({
    store: new MemoryStore(),
    keyResolver: new StaticKeyResolver(new Map([["test", "test-key"]]), { defaultQps: 0 }),
    anonymousQps: 0,
  });
  const fetch: Fetch = (request) => app.fetch(request);
  const agent = await createSession({ serverUrl, apiKey: "test-key", fetch, ...quick });
  const cdp = new FakeCdp();
  const driver = new TabDriver((method, params) => cdp.send(method, params), {
    mode,
    scope: hello.scope,
    url: hello.url,
    title: hello.title,
  });
  await driver.initialize();
  let detached = 0;
  let loseResultAcknowledgement = false;
  let lostAcknowledgements = 0;
  const browserFetch: Fetch = async (request) => {
    const response = await fetch(request);
    if (
      loseResultAcknowledgement &&
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/messages")
    ) {
      lostAcknowledgements++;
      throw new TypeError("Network connection lost after commit");
    }
    return response;
  };
  const share = await SharedSession.connect({
    ...quick,
    serverUrl,
    code: agent.code,
    fetch: browserFetch,
    hello: { ...hello, mode },
    driver,
    detach: async () => {
      detached++;
    },
  });
  return {
    agent: agent.session,
    code: agent.code,
    cdp,
    driver,
    share,
    detached: () => detached,
    loseResult: () => {
      loseResultAcknowledgement = true;
    },
    lostAcknowledgements: () => lostAcknowledgements,
    close: async () => {
      await share.stop("human");
      await share.settled();
    },
  };
}

async function refs(h: Awaited<ReturnType<typeof fixture>>) {
  const result = await h.agent.send("browser_snapshot");
  expect(result.ok).toBe(true);
  const text = (result.result as { text: string }).text;
  const input = text.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1];
  const button = text.match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
  expect(input).toBeTruthy();
  expect(button).toBeTruthy();
  if (!input || !button) throw new Error("Snapshot must expose input and button refs");
  return { input, button };
}

test("extension rejects malformed code before network redemption", async () => {
  let fetches = 0;
  const cdp = new FakeCdp();
  const driver = new TabDriver((method, params) => cdp.send(method, params), {
    mode: "act",
    scope: hello.scope,
    url: hello.url,
    title: hello.title,
  });
  await expect(
    SharedSession.connect({
      code: "rt1.invalid",
      serverUrl,
      hello,
      driver,
      detach: async () => {},
      fetch: async () => {
        fetches++;
        throw new Error("Must not fetch");
      },
    }),
  ).rejects.toThrow("valid rt1.");
  expect(fetches).toBe(0);
  expect(cdp.calls).toHaveLength(0);
});

test("extension sends authenticated consent hello and read mode denies acting commands without CDP input", async () => {
  const h = await fixture("read");
  try {
    expect(await h.agent.waitReady()).toEqual({ ...hello, mode: "read" });
    const { input, button } = await refs(h);
    const before = h.cdp.calls.length;
    for (const [tool, args] of [
      ["browser_click", { ref: button }],
      ["browser_type", { ref: input, text: "Denied" }],
      ["browser_navigate", { url: "https://example.test/next" }],
      ["browser_evaluate", { function: "() => 42" }],
    ] as const) {
      const denied = await h.agent.send(tool, args);
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe("mode_denied");
    }
    expect(
      h.cdp.calls
        .slice(before)
        .filter(
          (call) =>
            call.method.startsWith("Input.") ||
            call.method === "Page.navigate" ||
            call.method === "Runtime.evaluate",
        ),
    ).toHaveLength(0);
    expect(h.cdp.calls).toHaveLength(before);
    expect(h.cdp.value).toBe("");
  } finally {
    await h.close();
  }
});

test("real extension loop types and clicks through CDP with encrypted screenshots and correlated ledger", async () => {
  const h = await fixture();
  try {
    const { input, button } = await refs(h);
    const typed = await h.agent.send("browser_type", { ref: input, text: "Grace" });
    const clicked = await h.agent.send("browser_click", { ref: button });
    expect(h.cdp.value).toBe("Grace");
    expect(h.cdp.submitted).toBe("Submitted: Grace");
    for (const result of [typed, clicked]) {
      expect(result.ok).toBe(true);
      expect(result.screenshot?.mime_type).toBe("image/png");
      expect(result.attachments).toHaveLength(1);
      expect(new Uint8Array(result.attachments[0].bytes)).toEqual(PNG);
    }
    const ledger = await h.agent.ledger();
    expect(ledger.entries.map((entry) => entry.envelope.kind)).toEqual([
      "hello",
      "command",
      "result",
      "command",
      "result",
      "command",
      "result",
    ]);
    for (const result of [typed, clicked]) {
      const pair = ledger.entries.filter((entry) => entry.envelope.id === result.id);
      expect(pair.map((entry) => entry.envelope.kind)).toEqual(["command", "result"]);
      expect(new Uint8Array(pair[1].attachments[0].bytes)).toEqual(PNG);
      expect(pair[1].message.ciphertext).not.toContain("Grace");
    }
  } finally {
    await h.close();
  }
});

test("full mode permits evaluation while act mode denies it", async () => {
  for (const mode of ["act", "full"] as const) {
    const h = await fixture(mode);
    try {
      const before = h.cdp.calls.length;
      const result = await h.agent.send("browser_evaluate", { function: "() => 42" });
      expect(result.ok).toBe(mode === "full");
      expect(
        h.cdp.calls.slice(before).filter((call) => call.method === "Runtime.evaluate"),
      ).toHaveLength(mode === "full" ? 1 : 0);
      if (mode === "act") expect(result.error?.code).toBe("mode_denied");
      else expect(result.result).toBe(42);
    } finally {
      await h.close();
    }
  }
});

test("site-scoped navigation is rejected before Chrome navigates", async () => {
  const h = await fixture();
  try {
    const result = await h.agent.send("browser_navigate", { url: "https://other.test/private" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("scope_denied");
    expect(h.cdp.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(0);
    expect(h.cdp.url).toBe(hello.url);
  } finally {
    await h.close();
  }
});

test("lost result acknowledgement ends sharing and never repeats a committed acting command", async () => {
  const h = await fixture();
  try {
    const { button } = await refs(h);
    h.loseResult();
    const result = await h.agent.send("browser_click", { ref: button });
    expect(result.ok).toBe(true); // The server committed the result before its response was lost.
    await until(() => !h.share.state.sharing);
    await h.share.settled();
    expect(h.lostAcknowledgements()).toBe(1);
    expect(h.detached()).toBe(1);
    expect(
      h.cdp.calls.filter(
        (call) =>
          call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseReleased",
      ),
    ).toHaveLength(1);
    const ledger = await h.agent.ledger();
    expect(
      ledger.entries
        .filter((entry) => entry.envelope.id === result.id)
        .map((entry) => entry.envelope.kind),
    ).toEqual(["command", "result"]);
    expect(ledger.status.state).toBe("stopped");
  } finally {
    await h.close();
  }
});

test("human and agent stop each detach once and prevent subsequent commands", async () => {
  for (const who of ["human", "agent"] as const) {
    const h = await fixture();
    try {
      await h.agent.waitReady();
      if (who === "human") await Promise.all([h.share.stop("human"), h.share.stop("human")]);
      else await h.agent.stop();
      await until(() => h.detached() === 1);
      await h.share.settled();
      const before = h.cdp.calls.length;
      await expect(h.agent.send("browser_click", { ref: "e1" })).rejects.toMatchObject({
        code: "session_not_active",
      });
      expect(h.share.state.sharing).toBe(false);
      expect(h.cdp.calls).toHaveLength(before);
      expect((await h.agent.status()).state).toBe("stopped");
    } finally {
      await h.close();
    }
    expect(h.detached()).toBe(1);
  }
});
