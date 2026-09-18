import { expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { TakeoverMonitor } from "./takeover";

type Call = { method: string; params: Record<string, unknown>; sessionId?: string };
const key = { type: "keydown", key: "a", code: "KeyA", keyCode: 65, modifiers: 0, repeat: false };
const pointer = {
  type: "pointerdown",
  x: 14,
  y: 23,
  button: 0,
  pointerType: "mouse",
  modifiers: 0,
};

const inputTypes = [
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "wheel",
];
async function harness(foreignListeners: unknown[] = [], coldSessions = new Set<string>()) {
  const calls: Call[] = [];
  let human = 0;
  let raw: ((call: Call) => Promise<unknown>) | undefined;
  let resumed = () => {};
  const coldResumed = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const monitor = new TakeoverMonitor(
    async (method, params, sessionId) => {
      const call = { method, params: params ?? {}, sessionId };
      calls.push(call);
      if (method === "Runtime.runIfWaitingForDebugger" && sessionId && coldSessions.has(sessionId))
        resumed();
      if (method === "Runtime.enable" && !coldSessions.has(sessionId ?? ""))
        await monitor.onEvent(
          "Runtime.executionContextCreated",
          {
            context: { id: 90, name: "", auxData: { isDefault: true, frameId: "main" } },
          },
          sessionId,
        );
      if (method === "Page.addScriptToEvaluateOnNewDocument" && !coldSessions.has(sessionId ?? ""))
        await monitor.onEvent(
          "Runtime.executionContextCreated",
          {
            context: {
              id: 1,
              name: params?.worldName,
              auxData: { isDefault: false, frameId: "main" },
            },
          },
          sessionId,
        );
      if (method === "Runtime.evaluate" && params?.expression === "this")
        return { result: { className: "Window", objectId: `window-${params.contextId}` } };
      if (method === "DOMDebugger.getEventListeners")
        return {
          listeners:
            params?.objectId === "window-90"
              ? foreignListeners
              : inputTypes.map((type) => ({ type, useCapture: true })),
        };
      if (method === "Runtime.releaseObject") return {};
      if (raw) return raw(call);
      return { identifier: `script-${sessionId ?? "root"}` };
    },
    () => {
      human++;
    },
  );
  await monitor.initialize();
  const binding = String(calls.find((call) => call.method === "Runtime.addBinding")?.params.name);
  const script = calls.find((call) => call.method === "Page.addScriptToEvaluateOnNewDocument");
  const world = String(script?.params.worldName);
  const context = async (id = 1, sessionId?: string, name = world, isDefault = false) =>
    monitor.onEvent(
      "Runtime.executionContextCreated",
      {
        context: { id, name, auxData: { isDefault, frameId: "main" } },
      },
      sessionId,
    );
  const input = (value: unknown, id = 1, sessionId?: string, name = binding) =>
    monitor.onEvent(
      "Runtime.bindingCalled",
      {
        name,
        executionContextId: id,
        payload: JSON.stringify(value),
      },
      sessionId,
    );
  return {
    monitor,
    calls,
    binding,
    world,
    context,
    input,
    source: String(script?.params.source),
    coldResumed,
    publishColdContexts: async (sessionId: string) => {
      await context(90, sessionId, "", true);
      await context(1, sessionId);
    },
    humans: () => human,
    setRaw: (callback: typeof raw) => {
      raw = callback;
    },
  };
}

test("installs a named isolated world, binding and recursive iframe-only attachment", async () => {
  const h = await harness();
  expect(h.calls.find((c) => c.method === "Runtime.addBinding")?.params).toEqual({
    name: h.binding,
    executionContextName: h.world,
  });
  expect(
    h.calls.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")?.params,
  ).toMatchObject({
    worldName: h.world,
    runImmediately: true,
  });
  expect(h.calls.find((c) => c.method === "Target.setAutoAttach")?.params).toEqual({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }, { exclude: true }],
  });
  await h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { type: "iframe" },
    waitingForDebugger: true,
  });
  await h.monitor.onEvent(
    "Target.attachedToTarget",
    {
      sessionId: "grandchild",
      targetInfo: { type: "iframe" },
      waitingForDebugger: true,
    },
    "child",
  );
  for (const sessionId of ["child", "grandchild"]) {
    const childCalls = h.calls.filter((call) => call.sessionId === sessionId);
    expect(childCalls.some((call) => call.method === "Target.setAutoAttach")).toBe(true);
    expect(childCalls.findIndex((call) => call.method === "Target.setAutoAttach")).toBeLessThan(
      childCalls.findIndex((call) => call.method === "Runtime.runIfWaitingForDebugger"),
    );
    expect(
      childCalls.findIndex((call) => call.method === "Runtime.runIfWaitingForDebugger"),
    ).toBeLessThan(childCalls.findIndex((call) => call.method === "DOMDebugger.getEventListeners"));
  }
  const before = h.calls.length;
  await h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "other-tab",
    targetInfo: { type: "page" },
  });
  await h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "worker",
    targetInfo: { type: "worker" },
  });
  await h.monitor.onEvent(
    "Target.attachedToTarget",
    { sessionId: "foreign", targetInfo: { type: "iframe" } },
    "unknown",
  );
  expect(h.calls.length).toBe(before);
});

test("cold child resumes only after watcher installation and commands wait for real contexts and audit", async () => {
  const h = await harness([], new Set(["cold"]));
  const attaching = h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "cold",
    targetInfo: { type: "iframe" },
    waitingForDebugger: true,
  });
  await h.coldResumed;
  const pending = h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
  await Promise.resolve();
  expect(h.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);
  const setup = h.calls.filter((call) => call.sessionId === "cold").map((call) => call.method);
  expect(setup).toEqual([
    "Runtime.enable",
    "Runtime.addBinding",
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger",
  ]);
  await h.publishColdContexts("cold");
  await attaching;
  await pending;
  expect(h.humans()).toBe(0);
  expect(
    h.calls.some(
      (call) => call.sessionId === "cold" && call.method === "DOMDebugger.getEventListeners",
    ),
  ).toBe(true);
});

test("existing capture handlers and unrecognized listener metadata fail closed", async () => {
  await expect(harness([{ type: "keydown", useCapture: true }])).rejects.toThrow(
    "prevents reliable takeover",
  );
  await expect(harness([{ type: "pointerdown" }])).rejects.toThrow("prevents reliable takeover");
  const harmless = await harness([{ type: "keydown", useCapture: false }]);
  expect(harmless.humans()).toBe(0);
  expect(
    harmless.calls
      .filter((call) => call.method === "Runtime.evaluate")
      .every((call) => call.params.expression === "this"),
  ).toBe(true);
});

test("missing isolated watcher for a new frame blocks commands before raw dispatch", async () => {
  const h = await harness();
  await h.monitor.onEvent("Runtime.executionContextCreated", {
    context: { id: 99, name: "", auxData: { isDefault: true, frameId: "unwatched-frame" } },
  });
  await expect(
    h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }),
  ).rejects.toThrow("prevents reliable takeover");
  expect(h.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);
});

test("document.open invalidates takeover even if execution contexts survive", async () => {
  const h = await harness();
  await expect(h.monitor.onEvent("Page.documentOpened", {})).rejects.toThrow(
    "prevents reliable takeover",
  );
  await expect(h.monitor.dispatch("Runtime.evaluate", { expression: "1" })).rejects.toThrow(
    "prevents reliable takeover",
  );
});

test("isolated listener ignores synthetic input and reports only trusted event metadata", async () => {
  const h = await harness();
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const payloads: unknown[] = [];
  const world = {
    performance: { timeOrigin: 1000 },
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    [h.binding]: (payload: string) => payloads.push(JSON.parse(payload)),
  };
  runInNewContext(h.source, world);
  listeners.get("keydown")?.({ type: "keydown", isTrusted: false, key: "a" });
  expect(payloads).toEqual([]);
  listeners.get("keydown")?.({
    type: "keydown",
    isTrusted: true,
    key: "a",
    code: "KeyA",
    keyCode: 65,
    repeat: false,
    timeStamp: 42,
    target: { value: "PRIVATE PASSWORD", textContent: "PRIVATE PAGE" },
  });
  expect(payloads).toEqual([{ ...key, timestamp: 1042 }]);
  expect(JSON.stringify(payloads)).not.toContain("PRIVATE");
  runInNewContext(h.source, world);
  expect(listeners.size).toBe(7);
});

test("genuine keyboard, mouse, pen, touch and wheel input immediately notifies takeover", async () => {
  const h = await harness();
  for (const input of [
    key,
    pointer,
    { ...pointer, pointerType: "pen" },
    { ...pointer, pointerType: "touch" },
    { ...pointer, type: "wheel", deltaX: 0, deltaY: 10 },
  ]) {
    const before = h.humans();
    const pending = h.input(input);
    expect(h.humans()).toBe(before + 1);
    await pending;
  }
});

test("exact remote key and mouse events are consumed once during their dispatch", async () => {
  const h = await harness();
  h.setRaw(async ({ method, params }) => {
    const timestamp = Math.round(Number(params.timestamp) * 1000);
    if (method === "Input.dispatchKeyEvent") await h.input({ ...key, timestamp });
    else if (method === "Input.dispatchMouseEvent") await h.input({ ...pointer, timestamp });
    return { sent: true };
  });
  expect(
    await h.monitor.dispatch("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
    }),
  ).toEqual({ sent: true });
  await h.monitor.dispatch("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 14,
    y: 23,
    button: "left",
  });
  expect(h.humans()).toBe(0);
  await h.input(key);
  await h.input(pointer);
  expect(h.humans()).toBe(2);
});

test("different simultaneous key, modifiers, coordinates, event type or pointer type still pauses", async () => {
  const h = await harness();
  h.setRaw(async ({ method, params }) => {
    const timestamp = Math.round(Number(params.timestamp) * 1000);
    if (method === "Input.dispatchKeyEvent") {
      await h.input({ ...key, key: "b", keyCode: 66 });
      await h.input({ ...key, modifiers: 2 });
      await h.input({ ...key, type: "keyup" });
      await h.input({ ...key, timestamp });
    } else {
      await h.input({ ...pointer, x: 15 });
      await h.input({ ...pointer, pointerType: "touch" });
      await h.input({ ...pointer, timestamp });
      await h.input(pointer); // The single exact allowance cannot hide a second event.
    }
    return {};
  });
  await h.monitor.dispatch("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    windowsVirtualKeyCode: 65,
  });
  await h.monitor.dispatch("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 14,
    y: 23,
    button: "left",
  });
  expect(h.humans()).toBe(6);
});

test("failed dispatch clears its allowance, and non-input commands never suppress input", async () => {
  const h = await harness();
  h.setRaw(async () => {
    throw new Error("CDP failed");
  });
  await expect(
    h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }),
  ).rejects.toThrow("CDP failed");
  await h.input(key);
  expect(h.humans()).toBe(1);
  h.setRaw(async () => {
    await h.input(pointer);
    return { result: "passed through" };
  });
  expect(await h.monitor.dispatch("Runtime.evaluate", { expression: "1" })).toEqual({
    result: "passed through",
  });
  expect(h.humans()).toBe(2);
});

test("only known isolated contexts may report input, across navigation replacement", async () => {
  const h = await harness();
  await h.context(2, undefined, h.world, true);
  await h.context(3, undefined, "page-world", false);
  await h.input(key, 2);
  await h.input(key, 3);
  await h.input(key, 1, undefined, "wrong-binding");
  expect(h.humans()).toBe(0);
  await h.context(4); // Same-process iframe receives its own isolated context.
  await h.input(key, 4);
  expect(h.humans()).toBe(1);
  await h.monitor.onEvent("Runtime.executionContextDestroyed", { executionContextId: 4 });
  await h.input(key, 4);
  expect(h.humans()).toBe(1);
  await h.monitor.onEvent("Runtime.executionContextsCleared", {});
  await h.input(key);
  expect(h.humans()).toBe(1);
  await h.context(5);
  await h.input(key, 5);
  expect(h.humans()).toBe(2);
});

test("navigation clears in-flight expectations before accepting new context input", async () => {
  const h = await harness();
  h.setRaw(async () => {
    await h.monitor.onEvent("Runtime.executionContextsCleared", {});
    await h.context(2);
    await h.input(key, 2);
    return {};
  });
  await h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
  expect(h.humans()).toBe(1);
});

test("child input and dispatch are scoped by session and detached descendants are forgotten", async () => {
  const h = await harness();
  await h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { type: "iframe" },
  });
  await h.monitor.onEvent(
    "Target.attachedToTarget",
    { sessionId: "grandchild", targetInfo: { type: "iframe" } },
    "child",
  );
  h.setRaw(async ({ params }) => {
    await h.input({ ...key, timestamp: Math.round(Number(params.timestamp) * 1000) }, 1, "child");
    await h.input(key);
    return {};
  });
  await h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }, "child");
  expect(h.humans()).toBe(1);
  expect(h.calls.at(-1)?.sessionId).toBe("child");
  await h.monitor.onEvent("Target.detachedFromTarget", { sessionId: "child" });
  await h.input(key, 1, "child");
  await h.input(key, 1, "grandchild");
  expect(h.humans()).toBe(1);
});

test("late binding after dispatch response matches only its timestamp, never identical human input", async () => {
  const h = await harness();
  await h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
  const timestamp = Math.round(Number(h.calls.at(-1)?.params.timestamp) * 1000);
  expect(timestamp).toBeGreaterThan(Date.now() + 900);
  await h.input({ ...key, timestamp: Date.now() });
  expect(h.humans()).toBe(1);
  await h.input({ ...key, timestamp });
  expect(h.humans()).toBe(1);
  await h.input({ ...key, timestamp });
  expect(h.humans()).toBe(2);
});

test("a root dispatch marker follows child frames without comparing incompatible local coordinates", async () => {
  const h = await harness();
  await h.monitor.onEvent("Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { type: "iframe" },
  });
  await h.monitor.dispatch("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 414,
    y: 323,
    button: "left",
  });
  const timestamp = Math.round(Number(h.calls.at(-1)?.params.timestamp) * 1000);
  await h.input({ ...pointer, timestamp, modifiers: 2 }, 1, "child");
  expect(h.humans()).toBe(1);
  await h.input({ ...pointer, timestamp }, 1, "child");
  expect(h.humans()).toBe(1);
  await h.input({ ...pointer, timestamp: Date.now() }, 1, "child");
  expect(h.humans()).toBe(2);
});

test("human input at or after a stale automation marker cannot be swallowed", async () => {
  const h = await harness();
  await h.monitor.dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
  const timestamp = Math.round(Number(h.calls.at(-1)?.params.timestamp) * 1000);
  const clock = spyOn(Date, "now").mockReturnValue(timestamp);
  try {
    await h.input({ ...key, timestamp });
    expect(h.humans()).toBe(1);
    await h.input({ ...key, timestamp: timestamp + 1 });
    expect(h.humans()).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

test("dispose removes scripts and bindings and ignores subsequent input", async () => {
  const h = await harness();
  await h.monitor.dispose();
  await h.input(key);
  expect(h.humans()).toBe(0);
  expect(h.calls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument")).toBe(
    true,
  );
  expect(h.calls.some((call) => call.method === "Runtime.removeBinding")).toBe(true);
  await expect(h.monitor.dispatch("Input.dispatchKeyEvent", {})).rejects.toThrow("disposed");
});
