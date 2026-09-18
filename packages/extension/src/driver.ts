import type { Mode } from "@remote-tab/protocol";
import type { PrivacyGuard, ScreenshotClip } from "./privacy";
import { isWithinScope } from "./scope";

export type Cdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export class DriverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DriverError";
  }
}
export interface DriverOptions {
  mode: Mode;
  scope: string | null;
  url: string;
  title: string;
  onNotice?: (notice: { code: string; message: string }) => void;
  privacy?: PrivacyGuard;
  // Privacy layer hooks run inside the extension, before data reaches transport.
  sanitizeResult?: (value: unknown) => unknown | Promise<unknown>;
  beforeScreenshot?: () => Promise<void>;
  afterScreenshot?: () => Promise<void>;
}
export interface DriverResult {
  result: unknown;
  screenshot?: Uint8Array;
  blobs?: { bytes: Uint8Array; mimeType: string }[];
}
const READ = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
]);
const ACT = new Set([
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_drag",
  "browser_navigate",
  "browser_navigate_back",
  "browser_wait_for",
  "browser_evaluate",
]);
export const isActing = (tool: string): boolean => ACT.has(tool);
const MAX_SNAPSHOT = 200 * 1024;
const MAX_LOG = 48 * 1024;
const encoder = new TextEncoder();
const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown, max = 2000): string => String(value ?? "").slice(0, max);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const size = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
function required(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key])
    throw new DriverError("invalid", `${key} is required`);
  return args[key];
}
const CREDENTIAL = /authorization|cookie|token|api[-_]?key|secret|credential|csrf|xsrf/i;
export function redactHeaders(
  value: unknown,
  scrub: (value: unknown, max: number) => string = str,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec(value))
      .slice(0, 100)
      .map(([key, val]) => [
        scrub(key, 100),
        CREDENTIAL.test(key) ? "[redacted]" : scrub(val, 500),
      ]),
  );
}
function bounded(entries: Record<string, unknown>[]): {
  entries: Record<string, unknown>[];
  truncated: boolean;
} {
  const out = { entries: [...entries], truncated: false };
  while (size(out) > MAX_LOG && out.entries.length) {
    out.entries.shift();
    out.truncated = true;
  }
  return out;
}

// These functions are extension-owned source. Agent text is passed only as CDP
// call arguments; no selectors or page-supplied source are evaluated here.
const NODE_HELPER = `function(operation, value) {
  if (!this.isConnected) return { stale: true };
  if (operation === 'check') return { connected: true };
  if (operation === 'prepare') {
    this.scrollIntoView({block:'center',inline:'center'});
    const r=this.getBoundingClientRect();
    if (!r.width || !r.height) return { error:'Element is not visible' };
    const link=this.closest('a[href]');
    return {x:r.x+r.width/2,y:r.y+r.height/2,href:link ? link.href : null};
  }
  if (operation === 'type') {
    this.focus();
    if (this.isContentEditable) this.textContent=value;
    else if (this.tagName==='INPUT' || this.tagName==='TEXTAREA') {
      const proto=this.tagName==='INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);
    } else return {error:'Element is not editable'};
    this.dispatchEvent(new Event('input',{bubbles:true}));
    this.dispatchEvent(new Event('change',{bubbles:true}));
    return {typed:true};
  }
  if (operation === 'select') {
    if (this.tagName!=='SELECT') return {error:'Element is not a select'};
    if (!this.multiple && value.length!==1) return {error:'Select accepts one option'};
    if (value.some(v=>!Array.from(this.options).some(o=>o.value===v))) return {error:'Option not found'};
    for (const option of this.options) option.selected=value.includes(option.value);
    this.dispatchEvent(new Event('input',{bubbles:true}));
    this.dispatchEvent(new Event('change',{bubbles:true}));
    return {selected:true};
  }
}`;

export class TabDriver {
  private frameId = "";
  private contextId: number | undefined;
  private url: string;
  private title: string;
  private nextRef = 0;
  private refs = new Map<string, number>();
  private stableRefs = new Map<number, string>();
  private network = new Map<string, Record<string, unknown>>();
  private console: Record<string, unknown>[] = [];
  private networkDropped = 0;
  private consoleDropped = 0;
  private paused = false;
  private scopeError: DriverError | undefined;
  private loadedDocuments = new Set<string>();
  private loadWaiters = new Map<string, () => void>();
  private navigationPending = false;
  private navigationCompletions = 0;
  private navigationWaiters = new Set<() => void>();
  constructor(
    private readonly cdp: Cdp,
    private readonly options: DriverOptions,
  ) {
    this.url = options.url;
    this.title = options.title;
  }
  /** Human input may fill and clear a secret between scans. Discard diagnostics
   * across that boundary instead of retaining values the scanner never saw. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.clearDiagnostics();
  }
  private clearDiagnostics(): void {
    this.network.clear();
    this.console = [];
    this.networkDropped = 0;
    this.consoleDropped = 0;
  }
  private async scanPrivacy(): Promise<void> {
    await this.options.privacy?.scan();
    if (this.options.privacy?.hasSensitive) this.clearDiagnostics();
  }
  private checkPrivateTool(tool: string): void {
    if (
      this.options.privacy?.hasSensitive &&
      ["browser_console_messages", "browser_network_requests", "browser_evaluate"].includes(tool)
    )
      throw new DriverError(
        "privacy_denied",
        "Diagnostics and scripting are unavailable after this share encounters protected fields or uninspected embedded content",
      );
  }
  private async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return rec(await this.cdp(method, params));
  }
  private checkUrl(url: string): void {
    if (!isWithinScope(url, this.options.scope))
      throw new DriverError("scope_denied", "Navigation is outside the shared site scope");
  }
  private safeText(value: unknown, max = 2000): string {
    const clean = this.options.privacy ? this.options.privacy.sanitize(String(value ?? "")) : value;
    if (this.options.privacy && String(clean ?? "").length > max) return "[redacted: oversized]";
    return str(clean, max);
  }
  async initialize(): Promise<void> {
    this.checkUrl(this.url);
    // Install the interception barrier before accepting any command.
    await this.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
    for (const domain of ["Page", "DOM", "Accessibility", "Runtime", "Network", "Log"])
      await this.send(`${domain}.enable`);
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const tree = rec((await this.send("Page.getFrameTree")).frameTree);
    this.frameId = str(rec(tree.frame).id);
    // Keep the complete URL private: truncation before redaction can expose a
    // protected value's prefix when it crosses the output size boundary.
    if (rec(tree.frame).url) this.url = String(rec(tree.frame).url);
    this.checkUrl(this.url);
    await this.scanPrivacy();
  }
  private clearDocument(): void {
    this.contextId = undefined;
    this.refs.clear();
    this.stableRefs.clear();
  }
  async onEvent(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (
      (method === "Page.frameStartedLoading" || method === "Page.frameStartedNavigating") &&
      params.frameId === this.frameId
    )
      this.navigationPending = true;
    if (
      method === "Page.lifecycleEvent" &&
      params.name === "load" &&
      params.frameId === this.frameId
    ) {
      const loader = str(params.loaderId);
      this.loadedDocuments.add(loader);
      this.loadWaiters.get(loader)?.();
      this.finishNavigation();
      if (this.loadedDocuments.size > 20) {
        const oldest = this.loadedDocuments.values().next().value;
        if (oldest !== undefined) this.loadedDocuments.delete(oldest);
      }
    }
    if (method === "Fetch.requestPaused") {
      const url = str(rec(params.request).url, 10000);
      if (params.resourceType === "Document" && !isWithinScope(url, this.options.scope)) {
        const denied = new DriverError(
          "scope_denied",
          "Blocked navigation outside the shared site scope",
        );
        this.scopeError = denied;
        await this.send("Fetch.failRequest", {
          requestId: params.requestId,
          errorReason: "BlockedByClient",
        });
        for (const finish of this.loadWaiters.values()) finish();
        this.finishNavigation();
        this.options.onNotice?.({ code: denied.code, message: denied.message });
      } else {
        if (params.resourceType === "Document" && params.frameId === this.frameId)
          this.navigationPending = true;
        await this.send("Fetch.continueRequest", { requestId: params.requestId });
      }
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = rec(params.frame);
      if (!frame.parentId) {
        this.frameId = str(frame.id);
        this.url = String(frame.url ?? "");
        this.clearDocument();
        this.navigationPending = true;
        if (params.type === "BackForwardCacheRestore") this.finishNavigation();
        if (!isWithinScope(this.url, this.options.scope)) {
          this.scopeError = new DriverError("scope_denied", "Shared tab left the allowed site");
          this.finishNavigation();
          await this.send("Page.stopLoading");
          this.options.onNotice?.({
            code: "scope_lost",
            message: "Shared tab left the allowed site",
          });
        }
      }
      return;
    }
    if (method === "Page.navigatedWithinDocument" && params.frameId === this.frameId) {
      this.url = String(params.url ?? "");
      this.finishNavigation();
    }
    if (
      method === "Page.frameStoppedLoading" &&
      params.frameId === this.frameId &&
      this.navigationPending
    )
      this.finishNavigation();
    if (method === "DOM.documentUpdated" || method === "Runtime.executionContextsCleared")
      this.clearDocument();
    if (method === "Page.javascriptDialogOpening") {
      await this.send("Page.handleJavaScriptDialog", { accept: false });
      this.options.onNotice?.({ code: "dialog_dismissed", message: "A page dialog was dismissed" });
    }
    // Lifecycle and request interception above must keep working during handoff.
    if (this.paused || this.options.privacy?.hasSensitive) {
      this.clearDiagnostics();
      return;
    }
    if (method.startsWith("Network.") && typeof params.requestId === "string") {
      const id = params.requestId;
      const entry = this.network.get(id) ?? { requestId: id };
      if (method === "Network.requestWillBeSent") {
        const request = rec(params.request);
        Object.assign(entry, {
          url: this.safeText(request.url),
          method: this.safeText(request.method, 20),
          type: str(params.type, 40),
          requestHeaders: redactHeaders(request.headers, (value, max) => this.safeText(value, max)),
        });
      } else if (method === "Network.responseReceived") {
        const response = rec(params.response);
        Object.assign(entry, {
          status: response.status,
          mimeType: this.safeText(response.mimeType, 100),
          responseHeaders: redactHeaders(response.headers, (value, max) =>
            this.safeText(value, max),
          ),
        });
      } else if (method === "Network.loadingFailed")
        Object.assign(entry, { failed: true, error: this.safeText(params.errorText, 500) });
      else if (method === "Network.loadingFinished")
        Object.assign(entry, { done: true, bytes: params.encodedDataLength });
      else return;
      this.network.set(id, entry);
      while (this.network.size > 200) {
        const oldest = this.network.keys().next().value;
        if (oldest !== undefined) this.network.delete(oldest);
        this.networkDropped++;
      }
    }
    let log: Record<string, unknown> | undefined;
    if (method === "Runtime.consoleAPICalled")
      log = {
        level: str(params.type, 30),
        args: list(params.args)
          .slice(0, 10)
          .map((arg) => {
            const value = rec(arg);
            return this.safeText(
              value.value === undefined
                ? value.description
                : typeof value.value === "string"
                  ? value.value
                  : JSON.stringify(value.value),
              500,
            );
          }),
      };
    if (method === "Runtime.exceptionThrown") {
      const detail = rec(params.exceptionDetails);
      log = {
        level: "error",
        text: this.safeText(rec(detail.exception).description ?? detail.text, 1000),
      };
    }
    if (method === "Log.entryAdded")
      log = {
        level: str(rec(params.entry).level, 30),
        text: this.safeText(rec(params.entry).text, 1000),
      };
    if (log) {
      this.console.push(log);
      if (this.console.length > 200) {
        this.console.shift();
        this.consoleDropped++;
      }
    }
  }
  private finishNavigation(): void {
    this.navigationPending = false;
    this.navigationCompletions++;
    for (const finish of this.navigationWaiters) finish();
  }
  private async waitForNavigation(after?: number): Promise<void> {
    if (
      this.scopeError ||
      (after === undefined ? !this.navigationPending : this.navigationCompletions > after)
    )
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.navigationWaiters.delete(finish);
        reject(new DriverError("timeout", "Navigation did not finish within 10 seconds"));
      }, 10000);
      const finish = () => {
        clearTimeout(timer);
        this.navigationWaiters.delete(finish);
        resolve();
      };
      this.navigationWaiters.add(finish);
    });
  }
  private async waitForLoad(loaderId: unknown): Promise<void> {
    if (typeof loaderId !== "string" || this.loadedDocuments.has(loaderId) || this.scopeError)
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loadWaiters.delete(loaderId);
        reject(new DriverError("timeout", "Navigation did not finish within 10 seconds"));
      }, 10000);
      this.loadWaiters.set(loaderId, () => {
        clearTimeout(timer);
        this.loadWaiters.delete(loaderId);
        resolve();
      });
    });
  }
  private backend(ref: string): number {
    const id = this.refs.get(ref);
    if (id === undefined) throw new DriverError("stale_ref", "Ref is stale; take a new snapshot");
    return id;
  }
  private async world(): Promise<number> {
    if (this.contextId !== undefined) return this.contextId;
    const result = await this.send("Page.createIsolatedWorld", {
      frameId: this.frameId,
      worldName: "remote-tab-driver",
    });
    if (typeof result.executionContextId !== "number")
      throw new DriverError("driver_error", "Cannot create isolated context");
    this.contextId = result.executionContextId;
    return this.contextId;
  }
  private async node(
    ref: string,
    operation: string,
    value?: unknown,
  ): Promise<Record<string, unknown>> {
    const backendNodeId = this.backend(ref);
    let objectId: string | undefined;
    try {
      const result = await this.send("DOM.resolveNode", {
        backendNodeId,
        executionContextId: await this.world(),
      });
      objectId =
        typeof rec(result.object).objectId === "string"
          ? (rec(result.object).objectId as string)
          : undefined;
      if (!objectId) throw new DriverError("stale_ref", "Element no longer exists");
      const call = await this.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: NODE_HELPER,
        arguments: [{ value: operation }, { value }],
        returnByValue: true,
      });
      if (call.exceptionDetails) throw new DriverError("driver_error", "Element operation failed");
      const data = rec(rec(call.result).value);
      if (data.stale)
        throw new DriverError("stale_ref", "Element was detached; take a new snapshot");
      if (data.error) throw new DriverError("invalid", str(data.error));
      return data;
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError("stale_ref", "Element unavailable; take a new snapshot");
    } finally {
      if (objectId) await this.send("Runtime.releaseObject", { objectId });
    }
  }
  private async snapshot(ref?: string): Promise<() => unknown> {
    if (ref) await this.node(ref, "check");
    const response = await this.send("Accessibility.getFullAXTree");
    await this.scanPrivacy();
    let nodes = list(response.nodes).map(rec);
    if (ref) {
      const root = nodes.find((node) => node.backendDOMNodeId === this.backend(ref));
      const included = new Set<string>(root ? [str(root.nodeId)] : []);
      const byId = new Map(nodes.map((node) => [str(node.nodeId), node]));
      const pending = [...included];
      while (pending.length) {
        const node = byId.get(pending.pop() as string);
        for (const child of list(node?.childIds)) {
          const id = str(child);
          if (!included.has(id)) {
            included.add(id);
            pending.push(id);
          }
        }
      }
      nodes = nodes.filter((node) => included.has(str(node.nodeId)));
    }
    const byId = new Map(nodes.map((node) => [str(node.nodeId), node]));
    const ordered: { node: Record<string, unknown>; depth: number }[] = [];
    const visited = new Set<string>();
    const walk = (node: Record<string, unknown>, depth: number) => {
      const id = str(node.nodeId);
      if (visited.has(id)) return;
      visited.add(id);
      ordered.push({ node, depth });
      for (const child of list(node.childIds)) {
        const next = byId.get(str(child));
        if (next) walk(next, Math.min(depth + 1, 40));
      }
    };
    for (const node of nodes) if (!byId.has(str(node.parentId))) walk(node, 0);
    for (const node of nodes) walk(node, 0);
    const root = nodes.find((node) => rec(node.role).value === "RootWebArea");
    return () => {
      if (root) this.title = this.safeText(rec(root.name).value, 2000);
      const fresh = new Map<string, number>();
      const out = {
        url: this.safeText(this.url, 10000),
        title: this.safeText(this.title, 2000),
        text: "",
        truncated: false,
      };
      let bytes = size(out);
      for (const { node, depth } of ordered) {
        if (node.ignored) continue;
        const backend = node.backendDOMNodeId;
        const role = str(rec(node.role).value, 100);
        const name =
          typeof backend === "number" && this.options.privacy?.isSensitive(backend)
            ? "[redacted]"
            : this.safeText(rec(node.name).value, 2000);
        let refId: string | undefined;
        if (typeof backend === "number") {
          let id = this.stableRefs.get(backend);
          if (!id) {
            id = `e${++this.nextRef}`;
            this.stableRefs.set(backend, id);
          }
          refId = id;
        }
        // Values are deliberately omitted; the privacy layer can further sanitize names.
        const line = `${"  ".repeat(depth)}- ${role} ${JSON.stringify(name)}${refId ? ` [ref=${refId}]` : ""}\n`;
        const cost = size(line) - 2;
        if (bytes + cost > MAX_SNAPSHOT) {
          out.truncated = true;
          break;
        }
        bytes += cost;
        out.text += line;
        if (typeof backend === "number" && refId) fresh.set(refId, backend);
      }
      this.refs = fresh;
      this.stableRefs = new Map([...fresh].map(([id, backend]) => [backend, id]));
      return out;
    };
  }
  async screenshot(ref?: string): Promise<Uint8Array> {
    if (this.paused) throw new DriverError("paused", "Paused: you took over");
    this.checkUrl(this.url);
    let clip: ScreenshotClip | undefined;
    if (ref) {
      await this.node(ref, "prepare");
      const model = rec(
        (await this.send("DOM.getBoxModel", { backendNodeId: this.backend(ref) })).model,
      );
      const quad = list(model.border).map(Number);
      if (quad.length !== 8 || quad.some((n) => !Number.isFinite(n)))
        throw new DriverError("invalid", "Element has no visible box");
      const xs = quad.filter((_, i) => i % 2 === 0);
      const ys = quad.filter((_, i) => i % 2 === 1);
      clip = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        scale: 1,
      };
    }
    await this.options.beforeScreenshot?.();
    try {
      const capture = async (region?: ScreenshotClip) => {
        const result = await this.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          ...(region ? { clip: region } : {}),
        });
        if (typeof result.data !== "string")
          throw new DriverError("driver_error", "Screenshot returned no data");
        const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
        if (bytes.byteLength > 4 * 1024 * 1024)
          throw new DriverError("too_large", "Screenshot exceeds 4 MiB");
        return bytes;
      };
      return this.options.privacy
        ? await this.options.privacy.screenshot(capture, clip)
        : await capture(clip);
    } finally {
      await this.options.afterScreenshot?.();
    }
  }
  private async mouse(
    type: string,
    point: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (typeof point.x !== "number" || typeof point.y !== "number")
      throw new DriverError("invalid", "Element has no visible position");
    await this.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra });
  }
  private async key(key: string): Promise<void> {
    const parts = key.endsWith("+") ? key.slice(0, -1).split("+").filter(Boolean) : key.split("+");
    const actual = key.endsWith("+") ? "+" : (parts.pop() ?? "");
    let modifiers = 0;
    for (const part of parts) {
      const bit = ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 } as Record<string, number>)[
        part
      ];
      if (!bit) throw new DriverError("invalid", "Unknown key modifier");
      modifiers |= bit;
    }
    const codes: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      Space: 32,
      ";": 186,
      "=": 187,
      ",": 188,
      "-": 189,
      ".": 190,
      "/": 191,
      "`": 192,
      "[": 219,
      "\\": 220,
      "]": 221,
      "'": 222,
    };
    if (!actual || (actual.length !== 1 && !codes[actual]))
      throw new DriverError("invalid", "Unsupported key");
    const unshifted = "`1234567890-=[]\\;',./";
    const shifted = '~!@#$%^&*()_+{}|:"<>?';
    const shiftedIndex = shifted.indexOf(actual);
    const physical = shiftedIndex >= 0 ? unshifted[shiftedIndex] : actual;
    let character = actual === "Space" ? " " : actual.length === 1 ? actual : "";
    if (character && modifiers & 8) {
      const index = unshifted.indexOf(character);
      character = index >= 0 ? shifted[index] : character.toUpperCase();
    }
    const data = {
      key: character || actual,
      modifiers,
      windowsVirtualKeyCode: codes[physical] ?? physical.toUpperCase().charCodeAt(0),
    };
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...data,
      ...(!(modifiers & 7) && (character || actual === "Enter") ? { text: character || "\r" } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...data });
  }
  private sanitizeOutput(tool: string, value: unknown): unknown {
    const privacy = this.options.privacy;
    if (!privacy) return value;
    if (tool === "browser_evaluate") return privacy.sanitize(value);
    if (tool !== "browser_console_messages" && tool !== "browser_network_requests") return value;
    const output = rec(value);
    return {
      ...output,
      entries: list(output.entries).map((entry) => {
        const clean = { ...rec(entry) };
        // These fields originate in the page. Keep extension-owned keys, counts,
        // CDP ids, status codes and role/level vocabulary intact.
        for (const key of [
          "url",
          "method",
          "mimeType",
          "error",
          "args",
          "text",
          "requestHeaders",
          "responseHeaders",
        ])
          if (key in clean) clean[key] = privacy.sanitize(clean[key]);
        return clean;
      }),
    };
  }
  async execute(tool: string, args: Record<string, unknown> = {}): Promise<DriverResult> {
    if (this.paused) throw new DriverError("paused", "Paused: you took over");
    if (!READ.has(tool) && !ACT.has(tool))
      throw new DriverError("unknown_tool", "Unknown browser tool");
    if (
      (isActing(tool) && this.options.mode === "read") ||
      (tool === "browser_evaluate" && this.options.mode !== "full")
    )
      throw new DriverError("mode_denied", "Tool is not allowed in the shared mode");
    if ("selector" in args) throw new DriverError("invalid", "Use a snapshot ref, not a selector");
    this.checkUrl(this.url);
    this.scopeError = undefined;
    await this.scanPrivacy();
    this.checkPrivateTool(tool);
    let result: unknown = { ok: true };
    let renderSnapshot: (() => unknown) | undefined;
    if (tool === "browser_snapshot")
      renderSnapshot = await this.snapshot(typeof args.ref === "string" ? args.ref : undefined);
    else if (tool === "browser_take_screenshot")
      return {
        result: { captured: true },
        screenshot: await this.screenshot(typeof args.ref === "string" ? args.ref : undefined),
      };
    else if (tool === "browser_console_messages")
      result = { ...bounded(this.console), dropped: this.consoleDropped };
    else if (tool === "browser_network_requests")
      result = { ...bounded([...this.network.values()]), dropped: this.networkDropped };
    else if (tool === "browser_click" || tool === "browser_hover") {
      const point = await this.node(required(args, "ref"), "prepare");
      if (tool === "browser_click" && typeof point.href === "string") this.checkUrl(point.href);
      await this.mouse("mouseMoved", point);
      if (tool === "browser_click") {
        await this.mouse("mousePressed", point, { button: "left", clickCount: 1 });
        await this.mouse("mouseReleased", point, { button: "left", clickCount: 1 });
      }
    } else if (tool === "browser_type") {
      if (typeof args.text !== "string") throw new DriverError("invalid", "text is required");
      if (this.options.privacy?.isSensitive(this.backend(required(args, "ref"))))
        this.options.privacy.remember(args.text);
      result = await this.node(required(args, "ref"), "type", args.text);
      if (args.submit === true) await this.key("Enter");
    } else if (tool === "browser_select_option") {
      if (
        !Array.isArray(args.values) ||
        !args.values.length ||
        !args.values.every((v) => typeof v === "string")
      )
        throw new DriverError("invalid", "values must be strings");
      if (this.options.privacy?.isSensitive(this.backend(required(args, "ref"))))
        for (const value of args.values) this.options.privacy.remember(value);
      result = await this.node(required(args, "ref"), "select", args.values);
    } else if (tool === "browser_press_key") await this.key(required(args, "key"));
    else if (tool === "browser_drag") {
      const start = await this.node(required(args, "startRef"), "prepare");
      const end = await this.node(required(args, "endRef"), "prepare");
      await this.mouse("mouseMoved", start);
      await this.mouse("mousePressed", start, { button: "left", clickCount: 1 });
      await this.mouse("mouseMoved", end, { button: "left", buttons: 1 });
      await this.mouse("mouseReleased", end, { button: "left", clickCount: 1 });
    } else if (tool === "browser_navigate") {
      const url = required(args, "url");
      this.checkUrl(url);
      const navigation = await this.send("Page.navigate", { url });
      if (navigation.errorText)
        throw this.scopeError ?? new DriverError("navigation_failed", str(navigation.errorText));
      this.clearDocument();
      await this.waitForLoad(navigation.loaderId);
    } else if (tool === "browser_navigate_back") {
      const history = await this.send("Page.getNavigationHistory");
      const entry = rec(list(history.entries)[Number(history.currentIndex) - 1]);
      if (entry.id === undefined) throw new DriverError("invalid", "No previous history entry");
      this.checkUrl(str(entry.url, 10000));
      const completedBeforeBack = this.navigationCompletions;
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      this.clearDocument();
      // History traversal has no loaderId in its response. Arm against the
      // completion count before sending so events arriving during CDP cannot
      // be missed; same-document and BFCache restores also complete traversal.
      await this.waitForNavigation(completedBeforeBack);
    } else if (tool === "browser_wait_for") {
      if ((args.text !== undefined) === (args.time !== undefined))
        throw new DriverError("invalid", "Provide exactly one of text or time");
      if (args.time !== undefined) {
        if (
          typeof args.time !== "number" ||
          !Number.isFinite(args.time) ||
          args.time < 0 ||
          args.time > 30
        )
          throw new DriverError("invalid", "time must be 0–30 seconds");
        await new Promise((resolve) => setTimeout(resolve, Number(args.time) * 1000));
      } else {
        const text = required(args, "text");
        const waited = await this.send("Runtime.callFunctionOn", {
          executionContextId: await this.world(),
          functionDeclaration:
            "function(text) { return new Promise(resolve => { const found=()=>document.body && document.body.innerText.includes(text); if(found()) return resolve(true); const observer=new MutationObserver(()=>{if(found()){clearTimeout(timer);observer.disconnect();resolve(true)}}); observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true}); const timer=setTimeout(()=>{observer.disconnect();resolve(false)},10000); }); }",
          arguments: [{ value: text }],
          returnByValue: true,
          awaitPromise: true,
        });
        if (rec(waited.result).value !== true)
          throw new DriverError("timeout", "Text did not appear within 10 seconds");
      }
    } else if (tool === "browser_evaluate") {
      const evaluated = await this.send("Runtime.evaluate", {
        expression: `(${required(args, "function")})()`,
        returnByValue: true,
        awaitPromise: true,
        timeout: 10000,
      });
      if (evaluated.exceptionDetails)
        throw new DriverError("evaluation_failed", "Page function threw an exception");
      result = rec(evaluated.result).value ?? null;
      if (size(result) > MAX_SNAPSHOT)
        throw new DriverError("too_large", "Evaluation result exceeds 200 KiB");
    }
    if (isActing(tool)) await this.waitForNavigation();
    if (this.scopeError) throw this.scopeError;
    await this.scanPrivacy();
    this.checkPrivateTool(tool);
    result = renderSnapshot ? renderSnapshot() : this.sanitizeOutput(tool, result);
    result = this.options.sanitizeResult ? await this.options.sanitizeResult(result) : result;
    const screenshot = isActing(tool) ? await this.screenshot() : undefined;
    this.checkPrivateTool(tool);
    // Screenshot scans can discover newly filled fields. Scrub once more before
    // constructing any transport payload, with all discovered values available.
    if (screenshot) result = this.sanitizeOutput(tool, result);
    const bytes = encoder.encode(JSON.stringify(result));
    const output: DriverResult =
      bytes.length > MAX_LOG
        ? {
            result: { attached: "application/json" },
            blobs: [{ bytes, mimeType: "application/json" }],
          }
        : { result };
    if (screenshot) output.screenshot = screenshot;
    if (this.scopeError) throw this.scopeError;
    return output;
  }
}
