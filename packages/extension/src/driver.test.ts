import { describe, expect, test } from "bun:test";
import type { Mode } from "@remote-tab/protocol";
import { type Cdp, type DriverOptions, type DriverResult, TabDriver, isActing } from "./driver";

const ax = (id: number, name = `Element ${id}`, extra = {}) => ({
  nodeId: String(id),
  backendDOMNodeId: id,
  role: { value: "button" },
  name: { value: name },
  ...extra,
});
function fixture(options: Partial<DriverOptions> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const notices: { code: string; message: string }[] = [];
  const state = {
    nodes: [
      ax(1, "Page", { role: { value: "RootWebArea" }, childIds: ["2", "3"] }),
      ax(2, "Submit", { parentId: "1" }),
      ax(3, "Input", { parentId: "1" }),
    ],
    detached: false,
    href: null as string | null,
    history: {
      currentIndex: 1,
      entries: [
        { id: 1, url: "https://example.co.uk/old" },
        { id: 2, url: "https://example.co.uk" },
      ],
    },
    hook: undefined as
      | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
      | undefined,
  };
  const cdp: Cdp = async (method, params = {}) => {
    calls.push({ method, params });
    const override = await state.hook?.(method, params);
    if (override !== undefined) return override;
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "f1", url: "https://example.co.uk" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 42 };
      case "Accessibility.getFullAXTree":
        return { nodes: state.nodes };
      case "DOM.resolveNode":
        return { object: { objectId: "element" } };
      case "Runtime.callFunctionOn": {
        if (!params.objectId) return { result: { value: true } };
        const operation = (params.arguments as { value: unknown }[])[0].value;
        return {
          result: {
            value: state.detached
              ? { stale: true }
              : operation === "prepare"
                ? { x: 10, y: 20, href: state.href }
                : operation === "type"
                  ? { typed: true }
                  : { ok: true },
          },
        };
      }
      case "DOM.getBoxModel":
        return { model: { border: [0, 0, 100, 0, 100, 50, 0, 50] } };
      case "Page.captureScreenshot":
        return { data: btoa("png") };
      case "Page.getNavigationHistory":
        return state.history;
      case "Page.navigateToHistoryEntry":
        await driver.onEvent("Page.frameNavigated", {
          frame: { id: "f1", url: state.history.entries[0].url },
        });
        await driver.onEvent("Page.lifecycleEvent", {
          frameId: "f1",
          loaderId: "history",
          name: "load",
        });
        return {};
      case "Runtime.evaluate":
        return { result: { value: 42 } };
      default:
        return {};
    }
  };
  const driver = new TabDriver(cdp, {
    mode: "act",
    scope: "example.co.uk",
    url: "https://example.co.uk",
    title: "Page",
    onNotice: (notice) => notices.push(notice),
    ...options,
  });
  const count = (method: string) => calls.filter((call) => call.method === method).length;
  return { driver, state, calls, count, notices };
}
function result(output: DriverResult): Record<string, unknown> {
  return (
    output.blobs ? JSON.parse(new TextDecoder().decode(output.blobs[0].bytes)) : output.result
  ) as Record<string, unknown>;
}
const acting: [string, Record<string, unknown>][] = [
  ["browser_click", { ref: "e2" }],
  ["browser_hover", { ref: "e2" }],
  ["browser_type", { ref: "e3", text: "hello", submit: true }],
  ["browser_press_key", { key: "Control+a" }],
  ["browser_select_option", { ref: "e3", values: ["a"] }],
  ["browser_drag", { startRef: "e2", endRef: "e3" }],
  ["browser_navigate", { url: "https://other.example.co.uk" }],
  ["browser_navigate_back", {}],
  ["browser_wait_for", { time: 0 }],
  ["browser_wait_for", { text: "hello" }],
  ["browser_evaluate", { function: "() => 42" }],
];

describe("CDP driver", () => {
  test("installs interception before other domains and uses an isolated world for ref actions", async () => {
    const f = fixture();
    await f.driver.initialize();
    expect(f.calls[0]).toEqual({
      method: "Fetch.enable",
      params: {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
      },
    });
    await f.driver.execute("browser_snapshot");
    await f.driver.execute("browser_type", { ref: "e3", text: '" ); malicious(); //' });
    expect(f.calls.find((c) => c.method === "DOM.resolveNode")?.params).toEqual({
      backendNodeId: 3,
      executionContextId: 42,
    });
    const call = f.calls.find((c) => c.method === "Runtime.callFunctionOn");
    expect(call?.params.functionDeclaration).not.toContain("malicious");
    expect(call?.params.arguments).toEqual([{ value: "type" }, { value: '" ); malicious(); //' }]);
    expect(f.count("Runtime.releaseObject")).toBe(1);
  });
  test.each(acting)("read mode denies %s before any CDP effect", async (tool, args) => {
    const f = fixture({ mode: "read" });
    await expect(f.driver.execute(tool, args)).rejects.toMatchObject({ code: "mode_denied" });
    expect(f.calls).toHaveLength(0);
  });
  test.each(acting)("%s captures exactly one screenshot", async (tool, args) => {
    const f = fixture({ mode: "full" });
    await f.driver.initialize();
    await f.driver.execute("browser_snapshot");
    const output = await f.driver.execute(tool, args);
    expect(output.screenshot).toEqual(new TextEncoder().encode("png"));
    expect(f.count("Page.captureScreenshot")).toBe(1);
    expect(isActing(tool)).toBe(true);
  });
  test.each(["read", "act"] as Mode[])("%s denies evaluation", async (mode) => {
    const f = fixture({ mode });
    await expect(
      f.driver.execute("browser_evaluate", { function: "() => 1" }),
    ).rejects.toMatchObject({ code: "mode_denied" });
    expect(f.calls).toHaveLength(0);
  });
  test("read tools do not auto screenshot; explicit screenshot can crop", async () => {
    const f = fixture({ mode: "read" });
    await f.driver.initialize();
    for (const tool of ["browser_snapshot", "browser_console_messages", "browser_network_requests"])
      await f.driver.execute(tool);
    expect(f.count("Page.captureScreenshot")).toBe(0);
    await f.driver.execute("browser_take_screenshot", { ref: "e2" });
    expect(f.calls.find((c) => c.method === "Page.captureScreenshot")?.params.clip).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      scale: 1,
    });
    expect(f.count("Page.captureScreenshot")).toBe(1);
  });
  test("snapshots retain hierarchy and stable refs, narrow subtrees, discard stale refs", async () => {
    const f = fixture();
    await f.driver.initialize();
    const first = result(await f.driver.execute("browser_snapshot"));
    expect(first.text).toContain('- RootWebArea "Page" [ref=e1]\n  - button "Submit" [ref=e2]');
    expect(result(await f.driver.execute("browser_snapshot")).text).toBe(first.text);
    expect(result(await f.driver.execute("browser_snapshot", { ref: "e2" })).text).toBe(
      '- button "Submit" [ref=e2]\n',
    );
    await expect(f.driver.execute("browser_click", { ref: "e3" })).rejects.toMatchObject({
      code: "stale_ref",
    });
    await f.driver.onEvent("DOM.documentUpdated");
    await expect(f.driver.execute("browser_click", { ref: "e2" })).rejects.toMatchObject({
      code: "stale_ref",
    });
    expect(result(await f.driver.execute("browser_snapshot")).text).not.toContain("[ref=e2]");
  });
  test("detached nodes fail before Input and release the CDP handle", async () => {
    const f = fixture();
    await f.driver.initialize();
    await f.driver.execute("browser_snapshot");
    f.state.detached = true;
    await expect(f.driver.execute("browser_click", { ref: "e2" })).rejects.toMatchObject({
      code: "stale_ref",
    });
    expect(f.count("Input.dispatchMouseEvent")).toBe(0);
    expect(f.count("Runtime.releaseObject")).toBe(1);
  });
  test("snapshot UTF8 compaction respects 200 KiB and sends large text as an encrypted blob", async () => {
    const f = fixture();
    await f.driver.initialize();
    f.state.nodes = Array.from({ length: 10000 }, (_, i) => ax(i + 1, "界".repeat(2000)));
    const output = await f.driver.execute("browser_snapshot");
    expect(output.blobs).toHaveLength(1);
    expect(output.blobs?.[0].bytes.byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(result(output).truncated).toBe(true);
    expect(f.count("Page.captureScreenshot")).toBe(0);
  });
  test("scope gates direct navigate, history, and link click before input", async () => {
    const f = fixture();
    await f.driver.initialize();
    await f.driver.execute("browser_snapshot");
    await expect(
      f.driver.execute("browser_navigate", { url: "https://attacker.co.uk" }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    f.state.history.entries[0].url = "https://attacker.co.uk";
    await expect(f.driver.execute("browser_navigate_back")).rejects.toMatchObject({
      code: "scope_denied",
    });
    f.state.href = "https://attacker.co.uk";
    await expect(f.driver.execute("browser_click", { ref: "e2" })).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(f.count("Page.navigate")).toBe(0);
    expect(f.count("Page.navigateToHistoryEntry")).toBe(0);
    expect(f.count("Input.dispatchMouseEvent")).toBe(0);
  });
  test("redirect and script navigation are intercepted before the Document request", async () => {
    const f = fixture();
    await f.driver.initialize();
    await f.driver.onEvent("Fetch.requestPaused", {
      requestId: "ok",
      resourceType: "Document",
      request: { url: "https://sub.example.co.uk" },
    });
    await f.driver.onEvent("Fetch.requestPaused", {
      requestId: "redirect",
      resourceType: "Document",
      request: { url: "https://attacker.co.uk" },
    });
    expect(f.calls.filter((c) => c.method.startsWith("Fetch.")).slice(-2)).toEqual([
      { method: "Fetch.continueRequest", params: { requestId: "ok" } },
      {
        method: "Fetch.failRequest",
        params: { requestId: "redirect", errorReason: "BlockedByClient" },
      },
    ]);
    expect(f.notices[0].code).toBe("scope_denied");
  });
  test("redirect during an acting command is returned as scope_denied, including screenshot races", async () => {
    const f = fixture();
    await f.driver.initialize();
    f.state.hook = async (method) => {
      if (method === "Page.captureScreenshot")
        await f.driver.onEvent("Fetch.requestPaused", {
          requestId: "late",
          resourceType: "Document",
          request: { url: "https://attacker.co.uk" },
        });
      return undefined;
    };
    await expect(
      f.driver.execute("browser_navigate", { url: "https://example.co.uk/go" }),
    ).rejects.toMatchObject({ code: "scope_denied" });
  });
  test("navigation awaits matching load before screenshot and retains redirect destination", async () => {
    const f = fixture();
    await f.driver.initialize();
    f.state.hook = async (method) => {
      if (method !== "Page.navigate") return undefined;
      setTimeout(() => {
        void f.driver
          .onEvent("Page.frameNavigated", {
            frame: { id: "f1", url: "https://sub.example.co.uk/final" },
          })
          .then(() =>
            f.driver.onEvent("Page.lifecycleEvent", {
              frameId: "f1",
              loaderId: "l1",
              name: "load",
            }),
          );
      }, 1);
      return { loaderId: "l1" };
    };
    await f.driver.execute("browser_navigate", { url: "https://example.co.uk/start" });
    expect(result(await f.driver.execute("browser_snapshot")).url).toBe(
      "https://sub.example.co.uk/final",
    );
    expect(f.count("Page.captureScreenshot")).toBe(1);
  });
  test("scope loss stops loading and prevents all later reads", async () => {
    const f = fixture();
    await f.driver.initialize();
    await f.driver.onEvent("Page.frameNavigated", {
      frame: { id: "f1", url: "https://attacker.co.uk" },
    });
    expect(f.count("Page.stopLoading")).toBe(1);
    expect(f.notices[0].code).toBe("scope_lost");
    await expect(f.driver.execute("browser_snapshot")).rejects.toMatchObject({
      code: "scope_denied",
    });
  });
  test("history response waits for load before screenshot and keeps the final redirected URL", async () => {
    const f = fixture();
    await f.driver.initialize();
    f.state.hook = async (method) => (method === "Page.navigateToHistoryEntry" ? {} : undefined);
    const operation = f.driver.execute("browser_navigate_back");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.count("Page.navigateToHistoryEntry")).toBe(1);
    expect(f.count("Page.captureScreenshot")).toBe(0);
    await f.driver.onEvent("Page.frameNavigated", {
      frame: { id: "f1", url: "https://sub.example.co.uk/back-redirect" },
    });
    expect(f.count("Page.captureScreenshot")).toBe(0);
    await f.driver.onEvent("Page.lifecycleEvent", {
      frameId: "f1",
      loaderId: "back",
      name: "load",
    });
    await operation;
    expect(f.count("Page.captureScreenshot")).toBe(1);
    expect(result(await f.driver.execute("browser_snapshot")).url).toBe(
      "https://sub.example.co.uk/back-redirect",
    );
  });
  test.each(["same-document", "bfcache"])(
    "history %s completion does not wait for an absent load event",
    async (kind) => {
      const f = fixture();
      await f.driver.initialize();
      f.state.hook = async (method) => {
        if (method !== "Page.navigateToHistoryEntry") return undefined;
        if (kind === "same-document")
          await f.driver.onEvent("Page.navigatedWithinDocument", {
            frameId: "f1",
            url: "https://example.co.uk/#old",
          });
        else
          await f.driver.onEvent("Page.frameNavigated", {
            type: "BackForwardCacheRestore",
            frame: { id: "f1", url: "https://example.co.uk/old" },
          });
        return {};
      };
      await f.driver.execute("browser_navigate_back");
      expect(f.count("Page.captureScreenshot")).toBe(1);
    },
  );
  test.each([
    ["browser_click", { ref: "e2" }, "Input.dispatchMouseEvent", "mouseReleased"],
    [
      "browser_type",
      { ref: "e3", text: "query", submit: true },
      "Input.dispatchKeyEvent",
      "keyDown",
    ],
  ] as const)(
    "%s waits for a navigation detected during input dispatch",
    async (tool, args, trigger, type) => {
      const f = fixture();
      await f.driver.initialize();
      await f.driver.execute("browser_snapshot");
      f.state.hook = async (method, params) => {
        if (method === trigger && params.type === type)
          await f.driver.onEvent("Page.frameStartedLoading", { frameId: "f1" });
        return undefined;
      };
      const operation = f.driver.execute(tool, args);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.count("Page.captureScreenshot")).toBe(0);
      await f.driver.onEvent("Page.frameNavigated", {
        frame: { id: "f1", url: "https://example.co.uk/result" },
      });
      await f.driver.onEvent("Page.lifecycleEvent", {
        frameId: "f1",
        loaderId: "clicked",
        name: "load",
      });
      await operation;
      expect(f.count("Page.captureScreenshot")).toBe(1);
    },
  );
  test("network and console are bounded and credential headers are always redacted", async () => {
    const f = fixture();
    await f.driver.initialize();
    for (let i = 0; i < 300; i++) {
      await f.driver.onEvent("Network.requestWillBeSent", {
        requestId: String(i),
        request: {
          url: `https://example.co.uk/${i}`,
          method: "GET",
          headers: {
            AUTHORIZATION: "secret",
            Cookie: "secret",
            "x-api-key": "secret",
            "X-CuStOm-ToKeN": "secret",
            "X-SeCrEt-Key": "secret",
            X_Service_Credential: "secret",
            "X-APIKEY": "secret",
            Accept: "text/html",
          },
        },
      });
      await f.driver.onEvent("Network.responseReceived", {
        requestId: String(i),
        response: { status: 200, headers: { "Set-Cookie": "secret" } },
      });
      await f.driver.onEvent("Runtime.consoleAPICalled", {
        type: "log",
        args: [{ value: "界".repeat(10000) }],
      });
    }
    const network = result(await f.driver.execute("browser_network_requests"));
    expect(JSON.stringify(network)).not.toContain("secret");
    expect(JSON.stringify(network)).toContain("[redacted]");
    const headers = (network.entries as { requestHeaders: Record<string, string> }[])[0]
      .requestHeaders;
    expect(headers["X-CuStOm-ToKeN"]).toBe("[redacted]");
    expect(headers["X-SeCrEt-Key"]).toBe("[redacted]");
    expect(headers.X_Service_Credential).toBe("[redacted]");
    expect(headers["X-APIKEY"]).toBe("[redacted]");
    expect(headers.Accept).toBe("text/html");
    expect(network.dropped).toBe(100);
    expect(new TextEncoder().encode(JSON.stringify(network)).length).toBeLessThan(50 * 1024);
    const console = result(await f.driver.execute("browser_console_messages"));
    expect(console.dropped).toBe(100);
    expect(console.truncated).toBe(true);
    expect((console.entries as unknown[]).length).toBeLessThan(200);
  });
  test("dismisses dialogs and reports a notice", async () => {
    const f = fixture();
    await f.driver.onEvent("Page.javascriptDialogOpening");
    expect(f.calls[0]).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
    });
    expect(f.notices[0].code).toBe("dialog_dismissed");
  });
  test("privacy hooks sanitize before transport and remove masks after screenshot failure", async () => {
    const order: string[] = [];
    const f = fixture({
      mode: "full",
      sanitizeResult: () => {
        order.push("sanitize");
        return "[redacted]";
      },
      beforeScreenshot: async () => {
        order.push("mask");
      },
      afterScreenshot: async () => {
        order.push("unmask");
      },
    });
    const output = await f.driver.execute("browser_evaluate", { function: "() => 42" });
    expect(output.result).toBe("[redacted]");
    expect(order).toEqual(["sanitize", "mask", "unmask"]);
    f.state.hook = async (method) => {
      if (method === "Page.captureScreenshot") throw new Error("capture failure");
      return undefined;
    };
    await expect(f.driver.screenshot()).rejects.toThrow("capture failure");
    expect(order.slice(-2)).toEqual(["mask", "unmask"]);
  });
  test("rejects selectors, unknown commands and malformed waits", async () => {
    const f = fixture();
    await expect(f.driver.execute("browser_click", { selector: "body" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(f.driver.execute("browser_tabs")).rejects.toMatchObject({ code: "unknown_tool" });
    for (const args of [{ time: -1 }, { time: 31 }, { time: 0, text: "hi" }, {}])
      await expect(f.driver.execute("browser_wait_for", args)).rejects.toMatchObject({
        code: "invalid",
      });
  });
});

test("printable key text includes Space and Shift characters but excludes shortcuts", async () => {
  const h = fixture();
  for (const [key, expected] of [
    ["Space", " "],
    ["Shift+c", "C"],
    ["Shift+1", "!"],
    ["Shift+;", ":"],
    ["Shift+'", '"'],
    ["Shift+\\", "|"],
    ["Shift+/", "?"],
    ["Control+a", undefined],
    ["Alt+x", undefined],
    ["Meta+Shift+c", undefined],
  ] as const) {
    await h.driver.execute("browser_press_key", { key });
    const sent = h.calls.filter((call) => call.method === "Input.dispatchKeyEvent").at(-2);
    expect(sent?.params.text).toBe(expected);
    if (expected) expect(sent?.params.key).toBe(expected);
  }
});

test("punctuation uses OEM virtual keys instead of navigation/control key codes", async () => {
  const h = fixture();
  for (const [key, code] of [
    ["'", 222],
    [";", 186],
    [",", 188],
    ["/", 191],
    ["[", 219],
    ["\\", 220],
  ] as const) {
    await h.driver.execute("browser_press_key", { key: `Shift+${key}` });
    const sent = h.calls.filter((call) => call.method === "Input.dispatchKeyEvent").at(-2);
    expect(sent?.params.windowsVirtualKeyCode).toBe(code);
  }
});

test("literal printable symbols use physical keys and literal plus is accepted", async () => {
  const h = fixture();
  for (const [key, code] of [
    ['"', 222],
    ["!", 49],
    ["+", 187],
    ["?", 191],
  ] as const) {
    await h.driver.execute("browser_press_key", { key });
    const sent = h.calls.filter((call) => call.method === "Input.dispatchKeyEvent").at(-2);
    expect(sent?.params.text).toBe(key);
    expect(sent?.params.windowsVirtualKeyCode).toBe(code);
  }
});

test("browser_evaluate runs in the isolated world, not the page's main world", async () => {
  // Without a context, Runtime.evaluate runs in the MAIN world: the agent's
  // expression shares globals with page script, so a hostile page can redefine
  // JSON.stringify or proxy DOM getters and change what the agent reads back,
  // and the expression itself becomes visible to the page. Every other
  // evaluation in the driver already uses the isolated world; this one did not.
  const f = fixture({ mode: "full" });
  await f.driver.execute("browser_evaluate", { function: "() => 42" });
  const evaluate = f.calls.find((call) => call.method === "Runtime.evaluate");
  expect(evaluate).toBeDefined();
  // Runtime.evaluate spells it `contextId`; the sibling calls use
  // `executionContextId`. Passing the wrong name here would be silently
  // ignored and land back in the main world, so assert the exact key.
  expect(evaluate?.params.contextId).toBe(42);
  expect(f.count("Page.createIsolatedWorld")).toBeGreaterThan(0);
});
