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
  let cdpHook: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
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
  const attention = new HandoffAttention(async (method, params = {}) => {
    calls.push({ method, params });
    const override = await cdpHook?.(method, params);
    if (override !== undefined) return override;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "shared" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 71 };
    if (method === "Runtime.evaluate") return { result: { objectId: "ui" } };
    return {};
  });
  const ready = async () => {
    for (let i = 0; i < 100 && !calls.some((c) => c.method === "Runtime.evaluate"); i++)
      await Bun.sleep(1);
    expect(calls.some((c) => c.method === "Runtime.evaluate")).toBe(true);
  };
  return {
    attention,
    calls,
    ready,
    badge: () => badge,
    title: () => title,
    notifications: () => notifications,
    hook: (value: typeof cdpHook) => {
      cdpHook = value;
    },
  };
}
const expiry = () => new Date(Date.now() + 60000).toISOString();
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000 && !predicate(); i++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

test("a rejected refresh from an old handoff cannot revoke the new handoff", async () => {
  const h = fixture();
  let rejectOld: ((error: Error) => void) | undefined;
  h.hook(async (method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      String(params.functionDeclaration).includes("refresh")
    )
      return new Promise((_, reject) => {
        rejectOld = reject;
      });
    return undefined;
  });
  try {
    h.attention.show("Old request", expiry());
    await until(() => rejectOld !== undefined);
    await h.attention.clear();
    h.hook(undefined);
    h.calls.length = 0;
    h.attention.show("New request", expiry());
    await h.ready();
    rejectOld?.(new Error("Old context destroyed"));
    await Bun.sleep(10);
    expect(h.badge()).toBe("!");
    expect(h.notifications()).toBe(1);
    expect(h.calls.find((c) => c.method === "Runtime.evaluate")?.params.expression).toContain(
      "New request",
    );
  } finally {
    await h.attention.clear();
  }
});

test("a rejected installation from an old handoff preserves the queued attention", async () => {
  const h = fixture();
  let rejectOld: ((error: Error) => void) | undefined;
  h.hook(async (method) => {
    if (method === "Page.getFrameTree")
      return new Promise((_, reject) => {
        rejectOld = reject;
      });
    return undefined;
  });
  try {
    h.attention.show("Old request", expiry());
    await until(() => rejectOld !== undefined);
    h.attention.show("New request", expiry());
    h.hook(undefined);
    rejectOld?.(new Error("Old document replaced"));
    await h.ready();
    expect(h.badge()).toBe("!");
    expect(h.notifications()).toBe(1);
    expect(h.calls.find((c) => c.method === "Runtime.evaluate")?.params.expression).toContain(
      "New request",
    );
  } finally {
    await h.attention.clear();
  }
});

test("informational attention installs no acknowledgement binding and clears its remote object", async () => {
  const h = fixture();
  try {
    h.attention.show("Fill in the form", expiry());
    await h.ready();
    expect(h.badge()).toBe("!");
    expect(h.title()).toContain("your turn");
    expect(h.notifications()).toBe(1);
    expect(h.calls.some((c) => c.method === "Runtime.addBinding")).toBe(false);
    expect(h.calls.find((c) => c.method === "Runtime.evaluate")?.params.contextId).toBe(71);
    await h.attention.clear();
    expect(h.badge()).toBe("");
    expect(h.title()).toBe("Remote Tab");
    expect(h.notifications()).toBe(0);
    expect(h.calls.some((c) => c.params.functionDeclaration === "function(){this.clear()}")).toBe(
      true,
    );
    expect(
      h.calls.some((c) => c.method === "Runtime.releaseObject" && c.params.objectId === "ui"),
    ).toBe(true);
    expect(h.calls.some((c) => c.method === "Runtime.removeBinding")).toBe(false);
  } finally {
    await h.attention.clear();
  }
});

test("an extended lease is passed to the informational banner", async () => {
  const h = fixture();
  try {
    h.attention.show("Please confirm", expiry());
    await h.ready();
    const deadline = Date.now() + 120000;
    await h.attention.extend(new Date(deadline).toISOString());
    expect(
      h.calls.some((c) => c.params.functionDeclaration === `function(){this.refresh(${deadline})}`),
    ).toBe(true);
  } finally {
    await h.attention.clear();
  }
});

test("a cancelled installation leaves no attention", async () => {
  const h = fixture();
  try {
    h.attention.show("Must not appear", expiry());
    await h.attention.clear();
    expect(h.badge()).toBe("");
    expect(h.notifications()).toBe(0);
    expect(h.calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
  } finally {
    await h.attention.clear();
  }
});

test("clear waits for a late installation and removes its remote object", async () => {
  const h = fixture();
  let finishInstall: ((value: unknown) => void) | undefined;
  h.hook(async (method) => {
    if (method === "Runtime.evaluate")
      return new Promise((resolve) => {
        finishInstall = resolve;
      });
    return undefined;
  });
  try {
    h.attention.show("Old request", expiry());
    await until(() => finishInstall !== undefined);
    const clearing = h.attention.clear();
    finishInstall?.({ result: { objectId: "late-ui" } });
    await clearing;
    expect(h.badge()).toBe("");
    expect(h.notifications()).toBe(0);
    expect(
      h.calls.some((c) => c.method === "Runtime.releaseObject" && c.params.objectId === "late-ui"),
    ).toBe(true);
  } finally {
    await h.attention.clear();
  }
});

test("worker startup removes surviving browser chrome from a previous worker", async () => {
  const h = fixture();
  try {
    h.attention.show("Stale request", expiry());
    await h.ready();
    await clearAttentionChrome();
    expect(h.badge()).toBe("");
    expect(h.notifications()).toBe(0);
  } finally {
    await h.attention.clear();
  }
});
