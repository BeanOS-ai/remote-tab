import { afterEach, expect, test } from "bun:test";
import { type Fetch, createSession } from "@remote-tab/client";
import { MemoryStore, createApp } from "@remote-tab/server";
import type { ChromeApi, Sender, Tab } from "./chrome";

const origin = "https://installed-server.example";
const consentTab = { id: 17, url: "https://example.test/form", title: "Consented form" };
const originalFetch = globalThis.fetch;
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const originalOrigin = Object.getOwnPropertyDescriptor(globalThis, "REMOTE_TAB_SERVER_ORIGIN");
let cleanup: (() => Promise<void>) | undefined;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(hold?: "redeem" | "status") {
  const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["test", "test-key"]]) });
  const directFetch: Fetch = (request) => app.fetch(request);
  const { code, session } = await createSession({
    serverUrl: origin,
    apiKey: "test-key",
    fetch: directFetch,
  });
  const reached = deferred();
  const release = deferred();
  const requests: Request[] = [];
  const attached: number[] = [];
  const detached: number[] = [];
  const fetchedTabs: number[] = [];
  let statusReads = 0;
  let queries = 0;
  let tab: Tab = { ...consentTab };
  let onMessage: Parameters<ChromeApi["runtime"]["onMessage"]["addListener"]>[0];
  let onDetach: Parameters<ChromeApi["debugger"]["onDetach"]["addListener"]>[0];
  let onRemoved: Parameters<ChromeApi["tabs"]["onRemoved"]["addListener"]>[0];
  const api: ChromeApi = {
    runtime: {
      id: "installed-extension",
      getURL: (path) => `chrome-extension://installed-extension/${path}`,
      getManifest: () => ({ version: "2.0.0" }),
      sendMessage: async () => undefined,
      onMessage: {
        addListener: (listener) => {
          onMessage = listener;
        },
      },
    },
    tabs: {
      query: async () => {
        queries++;
        return [{ id: 99, url: "https://other.test/private", title: "Unconsented tab" }];
      },
      get: async (id) => {
        fetchedTabs.push(id);
        if (id !== consentTab.id) throw new Error("Unexpected tab");
        return { ...tab };
      },
      create: async () => ({}),
      onRemoved: {
        addListener: (listener) => {
          onRemoved = listener;
        },
      },
    },
    debugger: {
      attach: async ({ tabId }) => {
        attached.push(tabId);
      },
      detach: async ({ tabId }) => {
        detached.push(tabId);
      },
      sendCommand: async (_target, method) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main", url: consentTab.url } } }
          : {},
      onEvent: { addListener: () => {} },
      onDetach: {
        addListener: (listener) => {
          onDetach = listener;
        },
      },
    },
  };
  Object.assign(globalThis, {
    chrome: api,
    REMOTE_TAB_SERVER_ORIGIN: origin,
    fetch: async (request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === `/v1/sessions/${session.sessionId}`)
        statusReads++;
      // BrowserPeer verifies hello with two status reads; the third is connect's expiry read.
      if (
        (hold === "redeem" && url.pathname.endsWith("/redeem")) ||
        (hold === "status" &&
          statusReads === 3 &&
          request.method === "GET" &&
          url.pathname === `/v1/sessions/${session.sessionId}`)
      ) {
        reached.resolve();
        await release.promise;
      }
      return app.fetch(request);
    },
  });
  await import(`./worker.ts?test=${crypto.randomUUID()}`);
  const sender: Sender = { id: api.runtime.id, url: api.runtime.getURL("popup.html") };
  const message = (value: unknown) =>
    new Promise<unknown>((resolve) => {
      onMessage(value, sender, resolve);
    });
  cleanup = async () => {
    release.resolve();
    await message({ action: "stop" });
    await session.stop();
  };
  return {
    code,
    session,
    message,
    reached,
    release,
    requests,
    attached,
    detached,
    fetchedTabs,
    queries: () => queries,
    statusReads: () => statusReads,
    changeUrl: (url: string) => {
      tab = { ...tab, url };
    },
    detach: () => onDetach({ tabId: consentTab.id }, "canceled_by_user"),
    remove: () => onRemoved(consentTab.id),
    share: (overrides: Record<string, unknown> = {}) =>
      message({
        action: "share",
        code,
        mode: "read",
        siteOnly: true,
        tabId: consentTab.id,
        url: consentTab.url,
        ...overrides,
      }),
  };
}

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of [
    ["chrome", originalChrome],
    ["REMOTE_TAB_SERVER_ORIGIN", originalOrigin],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("sharing binds the popup's consented tab instead of reselecting the active tab", async () => {
  const h = await setup();
  expect(await h.share({ serverUrl: "https://untrusted.example" })).toEqual({ ok: true });
  expect(h.attached).toEqual([consentTab.id]);
  expect(h.queries()).toBe(0);
  expect(h.fetchedTabs.every((id) => id === consentTab.id)).toBe(true);
  expect(h.requests.length).toBeGreaterThan(0);
  expect(h.requests.every((request) => new URL(request.url).origin === origin)).toBe(true);
  const details = await h.session.statusDetails();
  expect(details.hello).toMatchObject({ url: consentTab.url, title: consentTab.title });
});

test("changed consent URL is rejected before attach or redemption", async () => {
  const h = await setup();
  h.changeUrl("https://example.test/private");
  expect(await h.share()).toMatchObject({ ok: false });
  expect(h.attached).toEqual([]);
  expect(h.requests).toEqual([]);
});

test("missing consent binding and malformed codes are rejected before attach or network", async () => {
  const h = await setup();
  for (const invalid of [{ tabId: undefined }, { url: undefined }, { code: "rt1.invalid" }])
    expect(await h.share(invalid)).toMatchObject({ ok: false });
  expect(h.attached).toEqual([]);
  expect(h.requests).toEqual([]);
});

for (const phase of ["redeem", "status"] as const) {
  for (const cancellation of ["stop", "detach", "remove"] as const) {
    test(`${cancellation} during deferred ${phase} cannot start the command loop`, async () => {
      const h = await setup(phase);
      const pending = h.share();
      await h.reached.promise;
      if (cancellation === "stop") await h.message({ action: "stop" });
      else h[cancellation]();
      h.release.resolve();
      expect(await pending).toMatchObject({ ok: false });
      expect(await h.message({ action: "state" })).toMatchObject({ sharing: false });
      expect(h.detached).toContain(consentTab.id);
      // No fourth status read: nextCommand never begins polling after cancellation.
      expect(h.statusReads()).toBeLessThanOrEqual(3);
      expect((await h.session.status()).state).toBe("stopped");
    });
  }
}
