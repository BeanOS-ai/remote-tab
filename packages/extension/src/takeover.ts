import { record } from "./chrome";

export type TakeoverSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

interface Input {
  type: string;
  modifiers: number;
  timestamp?: number;
  key?: string;
  code?: string;
  keyCode?: number;
  repeat?: boolean;
  x?: number;
  y?: number;
  button?: number;
  pointerType?: string;
  deltaX?: number;
  deltaY?: number;
}
interface Target {
  parent?: string;
  contexts: Set<number>;
  scriptId?: string;
}
interface Expected {
  input: Input;
  session: string;
}

// Only event metadata crosses the binding: never element text, values or DOM nodes.
function watcher(binding: string, cleanup: string): string {
  return `(() => {
    if (globalThis[${JSON.stringify(cleanup)}]) return;
    const listener = (event) => {
      if (!event.isTrusted) return;
      const report = globalThis[${JSON.stringify(binding)}];
      if (typeof report !== 'function') return;
      const input = {
        type: event.type,
        timestamp: Math.round(event.timeStamp + performance.timeOrigin),
        modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
      };
      if (event.type === 'keydown' || event.type === 'keyup') {
        input.key = event.key; input.code = event.code;
        input.keyCode = event.keyCode; input.repeat = event.repeat;
      } else {
        input.x = event.clientX; input.y = event.clientY;
        input.button = event.button;
        input.pointerType = event.pointerType || 'mouse';
        if (event.type === 'wheel') {
          input.deltaX = event.deltaX; input.deltaY = event.deltaY;
        }
      }
      report(JSON.stringify(input));
    };
    const types = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'wheel'];
    for (const type of types) globalThis.addEventListener(type, listener, { capture: true, passive: true });
    globalThis[${JSON.stringify(cleanup)}] = () => {
      for (const type of types) globalThis.removeEventListener(type, listener, true);
      delete globalThis[${JSON.stringify(cleanup)}];
    };
  })()`;
}

function expectedInput(method: string, params: Record<string, unknown>): Input | undefined {
  const modifiers = typeof params.modifiers === "number" ? params.modifiers : 0;
  if (method === "Input.dispatchKeyEvent") {
    if (!["keyDown", "rawKeyDown", "keyUp"].includes(String(params.type))) return;
    if (
      typeof params.key !== "string" &&
      typeof params.code !== "string" &&
      typeof params.windowsVirtualKeyCode !== "number"
    )
      return;
    return {
      type: params.type === "keyUp" ? "keyup" : "keydown",
      modifiers,
      ...(typeof params.key === "string" ? { key: params.key } : {}),
      ...(typeof params.code === "string" ? { code: params.code } : {}),
      ...(typeof params.windowsVirtualKeyCode === "number"
        ? { keyCode: params.windowsVirtualKeyCode }
        : {}),
      repeat: params.autoRepeat === true,
    };
  }
  if (method !== "Input.dispatchMouseEvent") return;
  const types: Record<string, string> = {
    mousePressed: "pointerdown",
    mouseReleased: "pointerup",
    mouseMoved: "pointermove",
    mouseWheel: "wheel",
  };
  const type = types[String(params.type)];
  if (!type || typeof params.x !== "number" || typeof params.y !== "number") return;
  const buttons: Record<string, number> = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };
  return {
    type,
    modifiers,
    x: params.x,
    y: params.y,
    button: type === "pointermove" ? -1 : (buttons[String(params.button)] ?? 0),
    pointerType: typeof params.pointerType === "string" ? params.pointerType : "mouse",
    ...(type === "wheel"
      ? { deltaX: Number(params.deltaX ?? 0), deltaY: Number(params.deltaY ?? 0) }
      : {}),
  };
}

/** Watches only the consented debugger target and its frame descendants. */
export class TakeoverMonitor {
  private readonly world = `remote-tab-takeover-${crypto.randomUUID()}`;
  private readonly binding = `__remoteTabInput_${crypto.randomUUID().replaceAll("-", "")}`;
  private readonly cleanup = `__remoteTabCleanup_${crypto.randomUUID().replaceAll("-", "")}`;
  private readonly targets = new Map<string, Target>();
  private readonly expected = new Set<Expected>();
  private timestamp = 0;
  private disposed = false;

  constructor(
    private readonly send: TakeoverSend,
    private readonly onHuman: () => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("Input monitor is disposed");
    if (this.targets.has("")) return;
    await this.install("");
  }

  private async install(session: string, parent?: string): Promise<void> {
    const target: Target = { parent, contexts: new Set() };
    this.targets.set(session, target);
    const call = (method: string, params?: Record<string, unknown>) =>
      this.send(method, params, session || undefined);
    await call("Runtime.enable");
    await call("Runtime.addBinding", { name: this.binding, executionContextName: this.world });
    await call("Page.enable");
    const script = await call("Page.addScriptToEvaluateOnNewDocument", {
      source: watcher(this.binding, this.cleanup),
      worldName: this.world,
      runImmediately: true,
    });
    if (record(script) && typeof script.identifier === "string")
      target.scriptId = script.identifier;
    await call("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
  }

  private forget(session: string): void {
    for (const [child, target] of this.targets) if (target.parent === session) this.forget(child);
    this.targets.delete(session);
    for (const event of this.expected) if (event.session === session) this.expected.delete(event);
  }

  async onEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    if (this.disposed) return;
    const session = sessionId ?? "";
    const target = this.targets.get(session);
    if (!target) return;
    if (method === "Target.attachedToTarget") {
      if (
        !record(params.targetInfo) ||
        params.targetInfo.type !== "iframe" ||
        typeof params.sessionId !== "string" ||
        this.targets.has(params.sessionId)
      )
        return;
      await this.install(params.sessionId, session);
      if (params.waitingForDebugger === true)
        await this.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") this.forget(params.sessionId);
      return;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (
        record(context) &&
        context.name === this.world &&
        typeof context.id === "number" &&
        record(context.auxData) &&
        context.auxData.isDefault === false
      )
        target.contexts.add(context.id);
      return;
    }
    if (
      method === "Runtime.executionContextsCleared" ||
      method === "Runtime.executionContextDestroyed"
    ) {
      if (method === "Runtime.executionContextsCleared") target.contexts.clear();
      else if (typeof params.executionContextId === "number")
        target.contexts.delete(params.executionContextId);
      for (const event of this.expected) if (event.session === session) this.expected.delete(event);
      return;
    }
    if (
      method !== "Runtime.bindingCalled" ||
      params.name !== this.binding ||
      typeof params.executionContextId !== "number" ||
      !target.contexts.has(params.executionContextId) ||
      typeof params.payload !== "string"
    )
      return;
    let input: unknown;
    try {
      input = JSON.parse(params.payload);
    } catch {
      this.onHuman();
      return;
    }
    if (!record(input)) {
      this.onHuman();
      return;
    }
    for (const event of this.expected) {
      // Rounding of DOM timestamps must not allow present human input to match.
      if (Number(event.input.timestamp) <= Date.now() + 2) {
        this.expected.delete(event);
        continue;
      }
      if (event.session !== session) continue;
      if (Object.entries(event.input).every(([key, value]) => input[key] === value)) {
        this.expected.delete(event);
        return;
      }
    }
    // Synchronous notification: the caller can pause before another command is dispatched.
    this.onHuman();
  }

  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Input monitor is disposed");
    const input = expectedInput(method, params);
    if (input) {
      this.timestamp = Math.max(Date.now() + 1000, this.timestamp + 1);
      input.timestamp = this.timestamp;
    }
    const expectation = input ? { input, session: sessionId ?? "" } : undefined;
    if (expectation) {
      // CDP acknowledges input before the renderer reports its DOM event. A unique
      // future timestamp identifies that event without a broad suppression window.
      // Page handlers see a timeStamp about 1s ahead: a compatibility tradeoff for
      // distinguishing delayed automation events from identical genuine input.
      // Once wall time approaches the marker it is never accepted; late automation
      // then safely pauses instead of swallowing a later genuine event.
      for (const event of this.expected)
        if (Number(event.input.timestamp) <= Date.now() + 2) this.expected.delete(event);
      this.expected.add(expectation);
      if (this.expected.size > 256) {
        const oldest = this.expected.values().next().value;
        if (oldest) this.expected.delete(oldest);
      }
    }
    try {
      return await this.send(
        method,
        input ? { ...params, timestamp: this.timestamp / 1000 } : params,
        sessionId,
      );
    } catch (error) {
      if (expectation) this.expected.delete(expectation);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.expected.clear();
    const cleanup: Promise<unknown>[] = [];
    for (const [session, target] of this.targets) {
      const call = (method: string, params: Record<string, unknown>) =>
        this.send(method, params, session || undefined).catch(() => {});
      for (const contextId of target.contexts)
        cleanup.push(
          call("Runtime.evaluate", {
            expression: `globalThis[${JSON.stringify(this.cleanup)}]?.()`,
            contextId,
          }),
        );
      if (target.scriptId)
        cleanup.push(
          call("Page.removeScriptToEvaluateOnNewDocument", { identifier: target.scriptId }),
        );
      cleanup.push(call("Runtime.removeBinding", { name: this.binding }));
    }
    this.targets.clear();
    await Promise.all(cleanup);
  }
}
