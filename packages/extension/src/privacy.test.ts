import { describe, expect, test } from "bun:test";
import { type Cdp, TabDriver } from "./driver";
import { type MaskRect, PrivacyGuard, type ScreenshotClip } from "./privacy";

interface Field {
  name?: string;
  attrs?: Record<string, string>;
  value?: string;
  box?: number[];
  hidden?: boolean;
}
function snapshot(fields: Field[] = []) {
  const strings: string[] = [];
  const index = (value: string) => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const nodes = [{ name: "#document" }, ...fields];
  const document = {
    frameId: index("f1"),
    documentURL: index("https://example.com"),
    nodes: {
      nodeName: nodes.map((node) => index(node.name ?? "INPUT")),
      backendNodeId: nodes.map((_, i) => i + 1),
      attributes: nodes.map((node) =>
        Object.entries(node.attrs ?? {}).flatMap(([key, value]) => [index(key), index(value)]),
      ),
      inputValue: {
        index: fields.flatMap((field, i) => (field.value === undefined ? [] : [i + 1])),
        value: fields.flatMap((field) => (field.value === undefined ? [] : [index(field.value)])),
      },
      shadowRootType: { index: [1], value: [index("closed")] },
    },
    layout: {
      nodeIndex: fields.flatMap((field, i) => (field.hidden ? [] : [i + 1])),
      bounds: fields
        .filter((field) => !field.hidden)
        .map((field) => field.box ?? [10, 20, 100, 30]),
    },
  };
  return { documents: [document], strings };
}
const password = { attrs: { type: "password" }, value: "sword-fish" };
function fixture(fields: Field[] = [password]) {
  const state = {
    snapshot: snapshot(fields),
    viewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
    hook: undefined as
      | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
      | undefined,
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const masks: { png: Uint8Array; clip: ScreenshotClip; masks: MaskRect[] }[] = [];
  const cdp: Cdp = async (method, params = {}) => {
    calls.push({ method, params });
    const response = await state.hook?.(method, params);
    if (response !== undefined) return response;
    if (method === "DOMSnapshot.captureSnapshot") return state.snapshot;
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: state.viewport };
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "f1", url: "https://example.com" } } };
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          {
            nodeId: "1",
            backendDOMNodeId: 2,
            role: { value: "textbox" },
            name: { value: "Password sword-fish" },
          },
          {
            nodeId: "2",
            backendDOMNodeId: 4,
            role: { value: "StaticText" },
            name: { value: "Echo sword-fish" },
          },
        ],
      };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "DOM.resolveNode") return { object: { objectId: "o1" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { typed: true } } };
    if (method === "Runtime.evaluate") return { result: { value: "ordinary result" } };
    if (method === "Page.captureScreenshot") return { data: btoa("raw pixels") };
    return {};
  };
  const privacy = new PrivacyGuard(cdp, {
    maskImage: async (png, clip, rectangles) => {
      masks.push({ png, clip, masks: rectangles });
      return new TextEncoder().encode("masked pixels");
    },
  });
  const driver = new TabDriver(cdp, {
    mode: "full",
    scope: null,
    url: "https://example.com",
    title: "Page",
    privacy,
  });
  return { state, calls, masks, privacy, driver };
}

describe("privacy guard", () => {
  test("Chromium empty-string sentinel still latches an empty protected input", async () => {
    const f = fixture([{ ...password, value: "" }]);
    f.state.snapshot.documents[0].nodes.inputValue.value[0] = -1;
    await f.privacy.scan();
    expect(f.privacy.hasSensitive).toBe(true);
    await expect(f.driver.execute("browser_console_messages")).rejects.toMatchObject({
      code: "privacy_denied",
    });
  });
  test("classifies password, tokenized autocomplete OTP/cc fields including closed shadow data", async () => {
    const f = fixture([
      password,
      { attrs: { autocomplete: "section-checkout billing CC-NUMBER" }, value: "4111111111111111" },
      { attrs: { autocomplete: "one-time-code" }, value: "123456" },
      { attrs: { type: "text" }, value: "public" },
    ]);
    await f.privacy.scan();
    expect(f.privacy.hasSensitive).toBe(true);
    for (const id of [2, 3, 4]) expect(f.privacy.isSensitive(id)).toBe(true);
    expect(f.privacy.isSensitive(5)).toBe(false);
    expect(
      f.privacy.sanitize({ text: "sword-fish 4111111111111111 123456 public", numeric: 123456 }),
    ).toEqual({ text: "[redacted] [redacted] [redacted] public", numeric: "[redacted]" });
  });
  test("scrubs nested object keys, standard encodings, and historic secrets after fields disappear", async () => {
    const f = fixture([{ ...password, value: "secret a/+" }]);
    await f.privacy.scan();
    f.state.snapshot = snapshot([]);
    await f.privacy.scan();
    expect(f.privacy.hasSensitive).toBe(true);
    expect(
      f.privacy.sanitize({ "secret a/+": ["secret%20a%2F%2B", btoa("secret a/+"), "ordinary"] }),
    ).toEqual({ "[redacted]": ["[redacted]", "[redacted]", "ordinary"] });
  });
  test("matches literal regex punctuation without exposing regex behavior", async () => {
    const f = fixture([{ ...password, value: ".*+[x](a)?$" }]);
    await f.privacy.scan();
    expect(f.privacy.sanitize("left .*+[x](a)?$ right")).toBe("left [redacted] right");
  });
  test("replacement stays idempotent even for single-character sensitive values", async () => {
    const f = fixture([{ ...password, value: "e" }]);
    await f.privacy.scan();
    const once = f.privacy.sanitize("secret");
    expect(f.privacy.sanitize(once)).toBe(once);
  });
  test("captures selected payment option values and labels", async () => {
    const f = fixture([
      { name: "SELECT", attrs: { autocomplete: "cc-type" } },
      { name: "OPTION", attrs: { value: "visa-gold" } },
      { name: "#text" },
    ]);
    const root = f.state.snapshot.documents[0];
    const label = f.state.snapshot.strings.push("Visa Gold") - 1;
    const empty = f.state.snapshot.strings.push("") - 1;
    Object.assign(root.nodes, {
      parentIndex: [-1, 0, 1, 2],
      nodeValue: [empty, empty, empty, label],
      optionSelected: { index: [2] },
    });
    await f.privacy.scan();
    expect(f.privacy.sanitize("visa-gold Visa Gold")).toBe("[redacted] [redacted]");
  });
  test("uninspected iframe content denies scripting even without known values", async () => {
    const f = fixture([{ name: "IFRAME", attrs: { src: "https://other.example" } }]);
    await expect(
      f.driver.execute("browser_evaluate", { function: "() => 42" }),
    ).rejects.toMatchObject({ code: "privacy_denied" });
    expect(f.calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
  });
  test("bounded historical values fail closed permanently rather than evict secrets", () => {
    const f = fixture([]);
    expect(() => f.privacy.remember("x".repeat(20000))).toThrow("Privacy protection");
    expect(() => f.privacy.sanitize("public")).toThrow("Privacy protection");
  });
  test("missing snapshot geometry is rejected, but hidden inputs need no layout box", async () => {
    const f = fixture([{ ...password, hidden: true }]);
    await f.privacy.screenshot(async () => new Uint8Array([1]));
    expect(f.masks[0].masks).toEqual([]);
    f.state.snapshot.documents[0].layout.bounds = [[10, 20, Number.NaN, 30]];
    f.state.snapshot.documents[0].layout.nodeIndex = [1];
    await expect(f.privacy.scan()).rejects.toMatchObject({ code: "privacy_denied" });
  });
  test("pixel transform receives sensitive rectangles and whole iframe bounds", async () => {
    const f = fixture([
      password,
      { name: "IFRAME", attrs: { src: "https://payments.example.net" }, box: [300, 100, 400, 200] },
    ]);
    const bytes = await f.privacy.screenshot(async (clip) => {
      expect(clip).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
      return new Uint8Array([9]);
    });
    expect(bytes).toEqual(new TextEncoder().encode("masked pixels"));
    expect(f.masks[0].masks).toEqual([
      { x: 10, y: 20, width: 100, height: 30 },
      { x: 300, y: 100, width: 400, height: 200 },
    ]);
  });
  test("clips masks using explicit document coordinates after scroll", async () => {
    const f = fixture([{ ...password, box: [25, 140, 100, 30] }]);
    f.state.viewport = { pageX: 0, pageY: 100, clientWidth: 800, clientHeight: 600 };
    await f.privacy.screenshot(async () => new Uint8Array([1]), {
      x: 0,
      y: 120,
      width: 200,
      height: 80,
      scale: 1,
    });
    expect(f.masks[0].clip).toEqual({ x: 0, y: 120, width: 200, height: 80, scale: 1 });
    expect(f.masks[0].masks[0].y).toBe(140);
  });
  test.each(["geometry", "viewport", "document"])(
    "withholds screenshot when %s changes during capture",
    async (kind) => {
      const f = fixture();
      await expect(
        f.privacy.screenshot(async () => {
          if (kind === "geometry") f.state.snapshot.documents[0].layout.bounds[0][0]++;
          if (kind === "viewport") f.state.viewport.pageY++;
          if (kind === "document")
            f.state.snapshot.strings[f.state.snapshot.documents[0].documentURL] =
              "https://example.com/other";
          return new Uint8Array([1]);
        }),
      ).rejects.toMatchObject({ code: "privacy_denied" });
      expect(f.masks).toHaveLength(0);
    },
  );
  test("scan failure never leaks underlying CDP error details", async () => {
    const f = fixture();
    f.state.hook = async () => {
      throw new Error("raw password sword-fish");
    };
    await expect(f.privacy.scan()).rejects.toThrow("Privacy protection");
  });
  test("driver masks direct and automatic screenshots and sanitizes AX names before truncation", async () => {
    const f = fixture();
    await f.driver.initialize();
    const snapshotResult = await f.driver.execute("browser_snapshot");
    expect(JSON.stringify(snapshotResult)).not.toContain("sword-fish");
    expect(JSON.stringify(snapshotResult)).toContain("[redacted]");
    const direct = await f.driver.execute("browser_take_screenshot");
    const automatic = await f.driver.execute("browser_wait_for", { time: 0 });
    expect(direct.screenshot).toEqual(new TextEncoder().encode("masked pixels"));
    expect(automatic.screenshot).toEqual(direct.screenshot);
    expect(f.masks).toHaveLength(2);
  });
  test("long accessible names are scrubbed before truncation can expose a secret prefix", async () => {
    const secret = "aB".repeat(1500);
    const f = fixture([{ ...password, value: secret }]);
    f.state.hook = async (method) =>
      method === "Accessibility.getFullAXTree"
        ? {
            nodes: [
              {
                nodeId: "1",
                backendDOMNodeId: 44,
                role: { value: "StaticText" },
                name: { value: `Echo ${secret}` },
              },
            ],
          }
        : undefined;
    const output = await f.driver.execute("browser_snapshot");
    expect(JSON.stringify(output)).not.toContain("aBaB");
    expect(JSON.stringify(output)).toContain("Echo [redacted]");
  });
  test.each(["1", "e"])(
    "short protected value %s cannot corrupt snapshot keys, roles or usable refs",
    async (value) => {
      const f = fixture([{ attrs: { autocomplete: "cc-exp-month" }, value }]);
      const output = await f.driver.execute("browser_snapshot");
      const content = output.result as { text: string };
      expect(Object.keys(content)).toEqual(["url", "title", "text", "truncated"]);
      expect(content.text).toContain('- textbox "[redacted]" [ref=e1]');
      expect(content.text).toContain("[ref=e2]");
      const typed = await f.driver.execute("browser_type", { ref: "e1", text: "2" });
      expect(typed.result).toEqual({ typed: true });
      expect(typed.screenshot).toEqual(new TextEncoder().encode("masked pixels"));
      await f.driver.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ value }] });
      await expect(f.driver.execute("browser_console_messages")).rejects.toMatchObject({
        code: "privacy_denied",
      });
    },
  );
  test("protected content first discovered during screenshot withholds the evaluation result", async () => {
    const f = fixture([]);
    f.state.hook = async (method) => {
      if (method === "Runtime.evaluate") return { result: { value: "late-secret" } };
      if (method === "Page.captureScreenshot")
        f.state.snapshot = snapshot([{ ...password, value: "late-secret", hidden: true }]);
      return undefined;
    };
    await expect(
      f.driver.execute("browser_evaluate", { function: "() => 'late-secret'" }),
    ).rejects.toMatchObject({ code: "privacy_denied" });
  });
  test("driver denies full evaluation with sensitive fields and allows it without them", async () => {
    const f = fixture();
    await f.driver.initialize();
    await expect(
      f.driver.execute("browser_evaluate", {
        function: "() => btoa(document.querySelector('input').value)",
      }),
    ).rejects.toMatchObject({ code: "privacy_denied" });
    expect(f.calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
    f.state.snapshot = snapshot([]);
    await expect(
      f.driver.execute("browser_evaluate", { function: "() => 1" }),
    ).rejects.toMatchObject({ code: "privacy_denied" });
    const ordinary = fixture([]);
    expect(
      (await ordinary.driver.execute("browser_evaluate", { function: "() => 1" })).result,
    ).toBe("ordinary result");
  });
  test("remembers typed sensitive values before a page immediately clears the input", async () => {
    const f = fixture();
    await f.driver.initialize();
    await f.driver.execute("browser_snapshot");
    f.state.hook = async (method) => {
      if (method === "Runtime.callFunctionOn")
        f.state.snapshot = snapshot([{ ...password, value: "" }]);
      return undefined;
    };
    await f.driver.execute("browser_type", { ref: "e1", text: "new-password" });
    expect(f.privacy.sanitize("new-password")).toBe("[redacted]");
  });
  test("never-sensitive pages retain diagnostics with bounded strings and credential redaction", async () => {
    const f = fixture([]);
    await f.driver.initialize();
    await f.driver.onEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "ordinary log" }, { value: "new-unknown".repeat(1000) }],
    });
    await f.driver.onEvent("Network.requestWillBeSent", {
      requestId: "n1",
      request: {
        url: "https://example.com/ordinary",
        method: "GET",
        headers: { Authorization: "sword-fish" },
      },
    });
    expect(JSON.stringify(await f.driver.execute("browser_console_messages"))).toContain(
      "ordinary log",
    );
    expect(JSON.stringify(await f.driver.execute("browser_console_messages"))).not.toContain(
      "new-unknown",
    );
    expect(JSON.stringify(await f.driver.execute("browser_network_requests"))).not.toContain(
      "sword-fish",
    );
  });
  test("handoff drops unknown transient OTP diagnostics while keeping request interception active", async () => {
    const f = fixture([{ attrs: { autocomplete: "one-time-code" }, value: "" }]);
    await f.driver.initialize();
    await f.driver.onEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "old log" }],
    });
    f.driver.setPaused(true);
    f.state.snapshot = snapshot([{ attrs: { autocomplete: "one-time-code" }, value: "654321" }]);
    await f.driver.onEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "OTP 654321" }],
    });
    await f.driver.onEvent("Network.requestWillBeSent", {
      requestId: "otp",
      request: {
        method: "GET",
        url: "https://example.com/?otp=654321",
        headers: { Echo: "654321" },
      },
    });
    await f.driver.onEvent("Fetch.requestPaused", {
      requestId: "request",
      resourceType: "Document",
      request: { url: "https://example.com" },
    });
    expect(f.calls.some((call) => call.method === "Fetch.continueRequest")).toBe(true);
    await expect(f.driver.execute("browser_snapshot")).rejects.toMatchObject({ code: "paused" });
    f.state.snapshot = snapshot([{ attrs: { autocomplete: "one-time-code" }, value: "" }]);
    f.driver.setPaused(false);
    for (const tool of ["browser_console_messages", "browser_network_requests"])
      await expect(f.driver.execute(tool)).rejects.toMatchObject({ code: "privacy_denied" });
    expect(JSON.stringify(f.driver)).not.toContain("654321");
  });
  test("unknown protected values logged and cleared between scans are never retained, even without pause", async () => {
    const f = fixture([{ ...password, value: "" }]);
    await f.driver.initialize();
    await f.driver.onEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "FAKE-PRIVATE-123" }],
    });
    await f.driver.onEvent("Network.requestWillBeSent", {
      requestId: "n",
      request: {
        method: "GET",
        url: "https://example.com/?secret=FAKE-PRIVATE-123",
        headers: { Echo: "FAKE-PRIVATE-123" },
      },
    });
    expect(JSON.stringify(f.driver)).not.toContain("FAKE-PRIVATE-123");
    f.state.snapshot = snapshot([]);
    await f.driver.onEvent("Page.frameNavigated", {
      frame: { id: "f1", url: "https://example.com/next" },
    });
    await f.driver.onEvent("Page.lifecycleEvent", {
      frameId: "f1",
      loaderId: "next",
      name: "load",
    });
    for (const tool of ["browser_console_messages", "browser_network_requests", "browser_evaluate"])
      await expect(f.driver.execute(tool, { function: "() => 1" })).rejects.toMatchObject({
        code: "privacy_denied",
      });
  });
  test("encountering protected content clears diagnostic payloads collected earlier", async () => {
    const f = fixture([]);
    await f.driver.initialize();
    await f.driver.onEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "old diagnostic payload" }],
    });
    expect(JSON.stringify(f.driver)).toContain("old diagnostic payload");
    f.state.snapshot = snapshot([{ ...password, value: "" }]);
    await f.driver.execute("browser_snapshot");
    expect(JSON.stringify(f.driver)).not.toContain("old diagnostic payload");
  });
});
