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
  worlds: Map<number, { frame: string; ours: boolean; default: boolean }>;
  audited: Set<number>;
  contextWaiters: Set<() => void>;
  scriptId?: string;
}
interface Expected {
  input: Input;
  session: string;
}
const INPUT_TYPES = [
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "wheel",
];
const UNAVAILABLE = "This page prevents reliable takeover monitoring. Sharing is unavailable.";
export class TakeoverError extends Error {
  readonly code = "takeover_unavailable";
  constructor() {
    super(UNAVAILABLE);
    this.name = "TakeoverError";
  }
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
  private readonly installing = new Set<Promise<void>>();
  private failure?: TakeoverError;
  private revision = 0;
  private humanRevision = 0;
  private timestamp = 0;
  private disposed = false;

  constructor(
    private readonly send: TakeoverSend,
    private readonly onHuman: () => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("Input monitor is disposed");
    if (this.targets.has("")) return;
    await this.startInstall("");
    await this.ready();
  }

  private fail(): TakeoverError {
    this.failure ??= new TakeoverError();
    this.human();
    return this.failure;
  }

  private human(): void {
    this.humanRevision++;
    this.onHuman();
  }

  private startInstall(session: string, parent?: string, waiting = false): Promise<void> {
    const task = this.install(session, parent, waiting).catch(() => {
      throw this.fail();
    });
    this.installing.add(task);
    void task.then(
      () => this.installing.delete(task),
      () => this.installing.delete(task),
    );
    return task;
  }

  private async install(session: string, parent?: string, waiting = false): Promise<void> {
    const target: Target = {
      parent,
      contexts: new Set(),
      worlds: new Map(),
      audited: new Set(),
      contextWaiters: new Set(),
    };
    this.targets.set(session, target);
    this.revision++;
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
    else throw this.fail();
    await call("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
    // Cold OOPIFs have no execution contexts until resumed. The watcher and its
    // recursive child attachment are installed first; dispatch waits on this task
    // until real context events arrive and every world passes admission.
    if (waiting) await call("Runtime.runIfWaitingForDebugger", {});
    await this.waitForWorlds(session, target);
    await this.audit(session, target);
  }

  private worldsReady(target: Target): boolean {
    if (!target.contexts.size || ![...target.worlds.values()].some((world) => world.default))
      return false;
    return [...target.worlds.values()].every(
      (world) =>
        [...target.worlds.values()].some((other) => other.frame === world.frame && other.ours) &&
        [...target.worlds.values()].some((other) => other.frame === world.frame && other.default),
    );
  }

  private waitForWorlds(session: string, target: Target): Promise<void> {
    if (this.worldsReady(target)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        target.contextWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.disposed || this.targets.get(session) !== target) finish(new TakeoverError());
        else if (this.worldsReady(target)) finish();
      };
      // Timeout only rejects; elapsed time can never admit an unchecked context.
      const timer = setTimeout(() => finish(new TakeoverError()), 10_000);
      target.contextWaiters.add(check);
      check();
    });
  }

  private async audit(session: string, target: Target): Promise<void> {
    if (!target.contexts.size || ![...target.worlds.values()].some((world) => world.default))
      throw this.fail();
    const frames = new Set([...target.worlds.values()].map((world) => world.frame));
    for (const frame of frames) {
      const worlds = [...target.worlds.values()].filter((world) => world.frame === frame);
      if (!worlds.some((world) => world.ours) || !worlds.some((world) => world.default))
        throw this.fail();
    }
    for (const [id, world] of target.worlds) {
      // document.open() can remove listeners without replacing execution contexts.
      // Recheck our listener integrity before every operation, not only admission.
      if (target.audited.has(id) && !world.ours) continue;
      // Top-level `this` is the actual Window even if the page replaces window/globalThis.
      const window = await this.send(
        "Runtime.evaluate",
        { expression: "this", contextId: id },
        session || undefined,
      );
      if (
        !record(window) ||
        !record(window.result) ||
        window.result.className !== "Window" ||
        typeof window.result.objectId !== "string"
      )
        throw this.fail();
      const objectId = window.result.objectId;
      try {
        const result = await this.send(
          "DOMDebugger.getEventListeners",
          { objectId },
          session || undefined,
        );
        if (!record(result) || !Array.isArray(result.listeners)) throw this.fail();
        const types = new Set<string>();
        for (const listener of result.listeners) {
          if (
            !record(listener) ||
            typeof listener.type !== "string" ||
            typeof listener.useCapture !== "boolean"
          )
            throw this.fail();
          if (!INPUT_TYPES.includes(listener.type) || !listener.useCapture) continue;
          if (!world.ours) throw this.fail();
          types.add(listener.type);
        }
        if (world.ours && INPUT_TYPES.some((type) => !types.has(type))) throw this.fail();
        target.audited.add(id);
      } finally {
        await this.send("Runtime.releaseObject", { objectId }, session || undefined).catch(
          () => {},
        );
      }
    }
  }

  private async ready(): Promise<void> {
    if (this.failure) throw this.failure;
    // A page that keeps replacing worlds cannot race admission with an unchecked world.
    for (let pass = 0; pass < 3; pass++) {
      while (this.installing.size) await Promise.all(this.installing);
      const revision = this.revision;
      for (const [session, target] of this.targets) {
        // A new iframe may attach while another target's asynchronous audit runs.
        while (this.installing.size) await Promise.all(this.installing);
        await this.audit(session, target);
      }
      if (revision === this.revision && !this.installing.size) return;
    }
    throw this.fail();
  }

  private forget(session: string): void {
    for (const [child, target] of this.targets) if (target.parent === session) this.forget(child);
    const target = this.targets.get(session);
    this.targets.delete(session);
    this.revision++;
    for (const notify of target?.contextWaiters ?? []) notify();
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
    if (method === "Page.documentOpened") throw this.fail();
    if (method === "Target.attachedToTarget") {
      if (
        !record(params.targetInfo) ||
        params.targetInfo.type !== "iframe" ||
        typeof params.sessionId !== "string" ||
        this.targets.has(params.sessionId)
      )
        return;
      await this.startInstall(params.sessionId, session, params.waitingForDebugger === true);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") this.forget(params.sessionId);
      return;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (
        !record(context) ||
        typeof context.id !== "number" ||
        typeof context.name !== "string" ||
        !record(context.auxData) ||
        typeof context.auxData.isDefault !== "boolean" ||
        typeof context.auxData.frameId !== "string"
      )
        throw this.fail();
      const ours = context.name === this.world && context.auxData.isDefault === false;
      target.worlds.set(context.id, {
        frame: context.auxData.frameId,
        ours,
        default: context.auxData.isDefault,
      });
      target.audited.delete(context.id);
      this.revision++;
      if (ours) target.contexts.add(context.id);
      for (const notify of target.contextWaiters) notify();
      return;
    }
    if (
      method === "Runtime.executionContextsCleared" ||
      method === "Runtime.executionContextDestroyed"
    ) {
      this.revision++;
      if (method === "Runtime.executionContextsCleared") {
        target.contexts.clear();
        target.worlds.clear();
        target.audited.clear();
      } else if (typeof params.executionContextId === "number") {
        target.contexts.delete(params.executionContextId);
        target.worlds.delete(params.executionContextId);
        target.audited.delete(params.executionContextId);
      }
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
      this.human();
      return;
    }
    if (!record(input)) {
      this.human();
      return;
    }
    for (const event of this.expected) {
      // Rounding of DOM timestamps must not allow present human input to match.
      if (Number(event.input.timestamp) <= Date.now() + 2) {
        this.expected.delete(event);
        continue;
      }
      let recipient: string | undefined = session;
      while (recipient !== undefined && recipient !== event.session)
        recipient = this.targets.get(recipient)?.parent;
      if (recipient !== event.session) continue;
      // CDP coordinates use the dispatch target viewport; DOM coordinates are frame-local.
      // The unique still-future trusted timestamp identifies the exact event across frames.
      if (
        Object.entries(event.input).every(
          ([key, value]) => key === "x" || key === "y" || input[key] === value,
        )
      ) {
        this.expected.delete(event);
        return;
      }
    }
    // Synchronous notification: the caller can pause before another command is dispatched.
    this.human();
  }

  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Input monitor is disposed");
    const humanRevision = this.humanRevision;
    try {
      await this.ready();
    } catch {
      throw this.fail();
    }
    if (this.disposed) throw new Error("Input monitor is disposed");
    if (humanRevision !== this.humanRevision) throw new Error("Paused: you took over");
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
    for (const target of this.targets.values())
      for (const notify of target.contextWaiters) notify();
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
