import { afterEach, expect, test } from "bun:test";
import { HandoffAttention, clearAttentionChrome } from "./handoff-attention";

const saved = Object.getOwnPropertyDescriptor(globalThis, "chrome");
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, "chrome", saved);
  else Reflect.deleteProperty(globalThis, "chrome");
});
function fixture() {
  let badge = "";
  let title = "";
  let notifications = 0;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const done: string[] = [];
  let failDone = false;
  Object.assign(globalThis, {
    chrome: {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
      action: {
        setBadgeText: async ({ text }: { text: string }) => {
          badge = text;
        },
        setTitle: async (options: { title: string }) => {
          title = options.title;
        },
        setBadgeBackgroundColor: async () => {},
      },
      notifications: {
        create: async () => {
          notifications++;
        },
        clear: async () => {
          notifications = 0;
        },
      },
    },
  });
  const attention = new HandoffAttention(
    async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "shared" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 71 };
      if (method === "Runtime.evaluate") return { result: { objectId: "ui" } };
      return {};
    },
    async (id) => {
      if (failDone) throw new Error("offline");
      done.push(id);
    },
  );
  const ready = async () => {
    for (let i = 0; i < 100 && !calls.some((c) => c.method === "Runtime.evaluate"); i++)
      await Bun.sleep(1);
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(true);
  };
  const binding = () => {
    const call = calls.find((c) => c.method === "Runtime.addBinding");
    const world = calls.find((c) => c.method === "Page.createIsolatedWorld");
    if (!call || !world) throw new Error("No isolated binding");
    return {
      name: call.params.name,
      executionContextId: 71,
      payload: String(world.params.worldName).replace("remote-tab-handoff-", ""),
    };
  };
  return {
    attention,
    calls,
    done,
    ready,
    binding,
    badge: () => badge,
    title: () => title,
    notifications: () => notifications,
    fail: (value: boolean) => {
      failDone = value;
    },
  };
}
const expiry = () => new Date(Date.now() + 60000).toISOString();

test("only the isolated context and current capability can complete a handoff", async () => {
  const h = fixture();
  try {
    h.attention.show("handoff-one", "Fill in the form", expiry());
    await h.ready();
    expect(h.badge()).toBe("!");
    expect(h.title()).toContain("your turn");
    expect(h.notifications()).toBe(1);
    const event = h.binding();
    for (const forged of [
      { ...event, executionContextId: 1 },
      { ...event, payload: "guessed" },
      { ...event, name: "forged" },
      { ...event, executionContextId: undefined },
    ])
      await h.attention.onEvent("Runtime.bindingCalled", forged);
    expect(h.done).toEqual([]);
    await h.attention.onEvent("Runtime.bindingCalled", event);
    await h.attention.onEvent("Runtime.bindingCalled", event);
    expect(h.done).toEqual(["handoff-one"]);
    await h.attention.clear();
    expect(h.badge()).toBe("");
    expect(h.title()).toBe("Remote Tab");
    expect(h.notifications()).toBe(0);
    expect(h.calls.some((c) => c.method === "Runtime.removeBinding")).toBe(true);
  } finally {
    await h.attention.clear();
  }
});

test("clear revokes Done synchronously and a later session rejects the old event", async () => {
  const h = fixture();
  try {
    h.attention.show("old", "Old request", expiry());
    await h.ready();
    const old = h.binding();
    const clearing = h.attention.clear();
    await h.attention.onEvent("Runtime.bindingCalled", old);
    await clearing;
    h.calls.length = 0;
    h.attention.show("new", "New request", expiry());
    await h.ready();
    await h.attention.onEvent("Runtime.bindingCalled", old);
    expect(h.done).toEqual([]);
    await h.attention.onEvent("Runtime.bindingCalled", h.binding());
    expect(h.done).toEqual(["new"]);
  } finally {
    await h.attention.clear();
  }
});

test("a failed delivery permits a real retry; a cancelled installation leaves no attention", async () => {
  const h = fixture();
  try {
    h.attention.show("retry", "Please confirm", expiry());
    await h.ready();
    h.fail(true);
    await h.attention.onEvent("Runtime.bindingCalled", h.binding());
    expect(h.done).toEqual([]);
    expect(h.calls.some((c) => c.params.functionDeclaration === "function(){this.retry()}")).toBe(
      true,
    );
    h.fail(false);
    await h.attention.onEvent("Runtime.bindingCalled", h.binding());
    expect(h.done).toEqual(["retry"]);
    h.attention.show("cancelled", "Must not appear", expiry());
    await h.attention.clear();
    expect(h.badge()).toBe("");
    expect(h.notifications()).toBe(0);
  } finally {
    await h.attention.clear();
  }
});

test("worker startup removes surviving browser chrome from a previous worker", async () => {
  const h = fixture();
  try {
    h.attention.show("stale", "Stale request", expiry());
    await h.ready();
    await clearAttentionChrome();
    expect(h.badge()).toBe("");
    expect(h.notifications()).toBe(0);
  } finally {
    await h.attention.clear();
  }
});
