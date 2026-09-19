import { afterEach, expect, test } from "bun:test";
import { type Fetch, createSession } from "@remote-tab/client";
import { until } from "../../../tests/e2e/fake-tab";
import { createApp } from "../../server/src/app";
import { StaticKeyResolver } from "../../server/src/key-resolver";
import { MemoryStore } from "../../server/src/memory-store";
import type { ChromeApi, Sender, Tab } from "./chrome";
import { loadLedger } from "./ledger-data";

const origin = "https://installed-server.example";
const consentTab = {
  id: 17,
  url: "https://example.test/form",
  title: "Consented form",
  windowId: 9,
};
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

async function setup(hold?: "redeem" | "status", sensitiveValue?: string) {
  const app = createApp({
    store: new MemoryStore(),
    keyResolver: new StaticKeyResolver(new Map([["test", "test-key"]]), { defaultQps: 0 }),
    anonymousQps: 0,
  });
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
  const createdUrls: string[] = [];
  const focusedTabs: number[] = [];
  const focusedWindows: number[] = [];
  let badge = "";
  let notification = false;
  let missing = false;
  let notificationClick: (id: string) => void = () => {};
  const cdpCalls: { method: string; params: Record<string, unknown> }[] = [];
  let holdNextWrite = false;
  let holdNextStop = false;
  let statusReads = 0;
  let queries = 0;
  let tab: Tab = { ...consentTab };
  let onMessage: Parameters<ChromeApi["runtime"]["onMessage"]["addListener"]>[0];
  let onDetach: Parameters<ChromeApi["debugger"]["onDetach"]["addListener"]>[0];
  let onEvent: Parameters<ChromeApi["debugger"]["onEvent"]["addListener"]>[0];
  let onRemoved: Parameters<ChromeApi["tabs"]["onRemoved"]["addListener"]>[0];
  const api: ChromeApi = {
    runtime: {
      id: "installed-extension",
      getURL: (path) => `chrome-extension://installed-extension/${path}`,
      getManifest: () => ({ version: "2.1.0" }),
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
        if (missing || id !== consentTab.id) throw new Error("Unexpected tab");
        return { ...tab };
      },
      update: async (id) => {
        focusedTabs.push(id);
        return tab;
      },
      create: async ({ url }) => {
        createdUrls.push(url);
        return { id: 88, url };
      },
      onRemoved: {
        addListener: (listener) => {
          onRemoved = listener;
        },
      },
    },
    windows: {
      update: async (id) => {
        focusedWindows.push(id);
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        badge = text;
      },
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    notifications: {
      create: async (id) => {
        notification = true;
        return id;
      },
      clear: async () => {
        notification = false;
        return true;
      },
      onClicked: {
        addListener: (listener) => {
          notificationClick = listener;
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
      sendCommand: async (_target, method, params = {}) => {
        cdpCalls.push({ method, params });
        if (method === "DOMSnapshot.captureSnapshot" && sensitiveValue)
          return {
            strings: ["main", tab.url, "INPUT", "type", "password", sensitiveValue],
            documents: [
              {
                frameId: 0,
                documentURL: 1,
                nodes: {
                  nodeName: [2],
                  backendNodeId: [10],
                  attributes: [[3, 4]],
                  inputValue: { index: [0], value: [5] },
                },
                layout: { nodeIndex: [0], bounds: [[0, 0, 100, 20]] },
              },
            ],
          };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate") return { result: { objectId: "handoff-ui" } };
        return method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main", url: consentTab.url } } }
          : method === "DOMSnapshot.captureSnapshot"
            ? {
                strings: ["main", consentTab.url],
                documents: [
                  {
                    frameId: 0,
                    documentURL: 1,
                    nodes: { nodeName: [], backendNodeId: [], attributes: [] },
                    layout: { nodeIndex: [], bounds: [] },
                  },
                ],
              }
            : {};
      },
      onEvent: {
        addListener: (listener) => {
          onEvent = listener;
        },
      },
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
      if (holdNextStop && request.method === "POST" && url.pathname.endsWith("/stop")) {
        holdNextStop = false;
        reached.resolve();
        await release.promise;
      }
      if (holdNextWrite && request.method === "POST" && url.pathname.endsWith("/messages")) {
        holdNextWrite = false;
        reached.resolve();
        await release.promise;
      }
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
  const message = (value: unknown, source: Sender = sender) =>
    new Promise<unknown>((resolve) => {
      onMessage(value, source, resolve);
    });
  cleanup = async () => {
    release.resolve();
    await message({ action: "stop" });
    await session.stop();
  };
  return {
    code,
    session,
    focusedTabs,
    focusedWindows,
    badge: () => badge,
    notification: () => notification,
    clickNotification: () => notificationClick("remote-tab-handoff"),
    closeTab: () => {
      missing = true;
    },
    createdUrls,
    ledgerMessage: (jobId: string, value: unknown) =>
      message(value, {
        id: api.runtime.id,
        url: api.runtime.getURL(`ledger.html#${jobId}`),
      }),
    anotherSession: () =>
      createSession({ serverUrl: origin, apiKey: "test-key", fetch: directFetch }),
    holdNextStop: () => {
      holdNextStop = true;
    },
    cdpCalls,
    holdNextWrite: () => {
      holdNextWrite = true;
    },
    redeemElsewhere: () =>
      directFetch(
        new Request(`${origin}/v1/sessions/${session.sessionId}/redeem`, { method: "POST" }),
      ),
    untrusted: (value: unknown, source: Sender) => {
      let responded = false;
      const accepted = onMessage(value, source, () => {
        responded = true;
      });
      return { accepted, responded: () => responded };
    },
    event: (method: string, params: Record<string, unknown>, target = consentTab.id) =>
      onEvent({ tabId: target }, method, params),
    changeTitle: (title: string) => {
      tab = { ...tab, title };
    },
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
  expect(details.hello).toMatchObject({
    url: consentTab.url,
    title: consentTab.title,
    extension_version: "2.1.0",
  });
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
  for (const invalid of [
    { tabId: undefined },
    { url: undefined },
    { code: "rt1.invalid" },
    { code: `rt1.${crypto.randomUUID()}.${"A".repeat(43)}` },
    { code: `rt1.${"A".repeat(43)}` },
    { code: `rt1.${"A".repeat(21)}B` },
  ])
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

test("already redeemed code gives actionable error and detaches the attempted tab", async () => {
  const h = await setup();
  expect((await h.redeemElsewhere()).status).toBe(200);
  expect(await h.share()).toEqual({
    ok: false,
    error: "This code was already used — tell your agent",
  });
  expect(h.attached).toEqual([consentTab.id]);
  expect(h.detached).toContain(consentTab.id);
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: false, starting: false });
});

test("only the exact installed popup can inspect state or perform human controls", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  const before = h.requests.length;
  const invalidSenders: Sender[] = [
    { id: "another-extension", url: "chrome-extension://installed-extension/popup.html" },
    { id: "installed-extension", url: consentTab.url, tab: consentTab },
    { id: "installed-extension", url: "chrome-extension://installed-extension/untrusted.html" },
    { id: "installed-extension", url: "chrome-extension://installed-extension/popup.html?spoof=1" },
    {},
  ];
  for (const source of invalidSenders) {
    for (const action of ["state", "stop", "pause", "resume", "done", "extend", "share"]) {
      const response = h.untrusted({ action, code: h.code }, source);
      expect(response.accepted).toBeUndefined();
      expect(response.responded()).toBe(false);
    }
  }
  expect(h.requests.slice(before).filter((request) => request.method === "POST")).toHaveLength(0);
  expect(h.detached).toHaveLength(0);
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, extended: false });
});

test("paused human navigation still resolves Fetch interception while agent actions stay denied", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  await h.message({ action: "pause" });
  expect(await h.message({ action: "state" })).toMatchObject({ paused: true });
  h.event("Fetch.requestPaused", {
    requestId: "human-same-site",
    resourceType: "Document",
    request: { url: "https://example.test/next" },
  });
  await until(() =>
    h.cdpCalls.some(
      (call) =>
        call.method === "Fetch.continueRequest" && call.params.requestId === "human-same-site",
    ),
  );
  h.event("Fetch.requestPaused", {
    requestId: "human-outside",
    resourceType: "Document",
    request: { url: "https://outside.test/" },
  });
  await until(() =>
    h.cdpCalls.some(
      (call) => call.method === "Fetch.failRequest" && call.params.requestId === "human-outside",
    ),
  );
  expect(h.detached).toHaveLength(0);
  const before = h.cdpCalls.length;
  expect(await h.session.send("browser_snapshot", {}, { timeoutMs: 2000 })).toMatchObject({
    ok: false,
    error: { code: "paused" },
  });
  expect(h.cdpCalls).toHaveLength(before);
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, paused: true });
});

test("sensitive metadata is redacted in hello and never reintroduced by popup status polling", async () => {
  const secret = "worker-secret-9137";
  const h = await setup(undefined, secret);
  h.changeTitle(`Account ${secret}`);
  expect(await h.share()).toEqual({ ok: true });
  const ready = await h.session.waitReady();
  expect(ready.title).toBe("Account [redacted]");
  expect(JSON.stringify(ready)).not.toContain(secret);
  // Popup is local and may show the real title; the agent's status must not inherit it.
  expect(await h.message({ action: "state" })).toMatchObject({ title: `Account ${secret}` });
  const status = await h.session.send("remote_tab_status", {}, { timeoutMs: 2000 });
  expect(status.ok).toBe(true);
  expect(JSON.stringify(status)).not.toContain(secret);
  expect(
    JSON.stringify((await h.session.ledger()).entries.map((entry) => entry.envelope)),
  ).not.toContain(secret);
});

test("explicit Pause while Done is awaiting delivery preserves the new pause", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  const handedBack = h.session.handoff("Please confirm");
  let state: unknown;
  await until(() =>
    h.requests.some((request) => new URL(request.url).pathname.endsWith("/messages")),
  );
  for (let i = 0; i < 100; i++) {
    state = await h.message({ action: "state" });
    if ((state as { handoff?: unknown }).handoff) break;
    await Bun.sleep(5);
  }
  expect(state).toMatchObject({ paused: true, handoff: { message: "Please confirm" } });
  h.holdNextWrite();
  const done = h.message({ action: "done" });
  await h.reached.promise;
  await h.message({ action: "pause" });
  h.release.resolve();
  expect(await done).toEqual({ ok: true });
  await handedBack;
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, paused: true });
  const before = h.cdpCalls.length;
  expect(await h.session.send("browser_snapshot", {}, { timeoutMs: 2000 })).toMatchObject({
    ok: false,
    error: { code: "paused" },
  });
  expect(h.cdpCalls).toHaveLength(before);
});

test("Stop detaches and opens one local ledger before a delayed server stop completes", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  h.holdNextStop();
  const stop = h.message({ action: "stop" });
  await h.reached.promise;
  expect(h.detached).toEqual([consentTab.id]);
  expect(h.createdUrls).toHaveLength(1);
  const url = new URL(h.createdUrls[0]);
  expect(url.protocol).toBe("chrome-extension:");
  expect(url.pathname).toBe("/ledger.html");
  expect(h.createdUrls[0].includes(h.code)).toBe(false);
  const jobId = url.hash.slice(1);
  expect(await h.ledgerMessage(jobId, { action: "ledger-status", jobId })).toMatchObject({
    state: "loading",
  });
  h.release.resolve();
  expect(await stop).toEqual({ ok: true });
  await h.message({ action: "stop" });
  expect(h.createdUrls).toHaveLength(1);
  const ledger = await loadLedger(jobId, (value) => h.ledgerMessage(jobId, value));
  expect(ledger.sessionId).toBe(h.session.sessionId);
  expect(ledger.status.state).toBe("stopped");
  expect(ledger.entries[0].envelope.kind).toBe("hello");
});

test("ledger transfer stays bound to the stopped peer after another share starts", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  await h.message({ action: "stop" });
  const jobId = new URL(h.createdUrls[0]).hash.slice(1);
  const next = await h.anotherSession();
  expect(await h.share({ code: next.code })).toEqual({ ok: true });
  const ledger = await loadLedger(jobId, (value) => h.ledgerMessage(jobId, value));
  expect(ledger.sessionId).toBe(h.session.sessionId);
  expect(ledger.sessionId).not.toBe(next.session.sessionId);
  expect((await next.session.status()).state).toBe("active");
});

test("only the matching installed ledger page can retrieve its job", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  await h.message({ action: "stop" });
  const jobId = new URL(h.createdUrls[0]).hash.slice(1);
  for (const source of [
    { id: "installed-extension", url: "https://page.test/" },
    { id: "wrong-extension", url: h.createdUrls[0] },
    {
      id: "installed-extension",
      url: `chrome-extension://installed-extension/ledger.html#${crypto.randomUUID()}`,
    },
  ])
    expect(h.untrusted({ action: "ledger-status", jobId }, source).accepted).toBeUndefined();
  expect(await h.message({ action: "ledger-status", jobId })).toMatchObject({ ok: false });
  const ledger = await loadLedger(jobId, (value) => h.ledgerMessage(jobId, value));
  expect(ledger.status.state).toBe("stopped");
});

test("only explicit Pause pauses; Resume re-enables sharing and ledger records both controls", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  expect(
    h.cdpCalls.some(({ method }) =>
      ["Runtime.addBinding", "DOMDebugger.getEventListeners"].includes(method),
    ),
  ).toBe(false);
  h.event("Runtime.bindingCalled", {
    name: "old-takeover",
    executionContextId: 2,
    payload: JSON.stringify({ type: "pointerdown", timestamp: Date.now() }),
  });
  h.event("Page.frameNavigated", { frame: { id: "main", url: consentTab.url } });
  expect(await h.message({ action: "state" })).toMatchObject({ paused: false });
  expect(await h.message({ action: "pause" })).toEqual({ ok: true });
  const state = await h.message({ action: "state" });
  expect(state).toMatchObject({
    paused: true,
    notice: expect.stringMatching(/^Paused by you at .* UTC$/),
  });
  const result = await h.session.send("browser_snapshot", {}, { timeoutMs: 2000 });
  expect(result).toMatchObject({ ok: false, error: { code: "paused" } });
  expect(await h.message({ action: "resume" })).toEqual({ ok: true });
  expect(await h.message({ action: "state" })).toMatchObject({ paused: false });
  await h.message({ action: "pause" });
  await h.message({ action: "stop" });
  const jobId = new URL(h.createdUrls[0]).hash.slice(1);
  const ledger = await loadLedger(jobId, (value) => h.ledgerMessage(jobId, value));
  expect(ledger.controlEvents?.map(({ action }) => action)).toEqual(["pause", "resume", "pause"]);
  for (const event of ledger.controlEvents ?? [])
    expect(Number.isFinite(Date.parse(event.timestamp))).toBe(true);
});

test("other-tab popup identifies and focuses the shared tab across windows; closed tab stays actionable", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  expect(await h.message({ action: "state" })).toMatchObject({
    tabId: 17,
    windowId: 9,
    tabMissing: false,
  });
  expect(await h.message({ action: "focus-shared" })).toEqual({ ok: true });
  expect(h.focusedTabs).toEqual([17]);
  expect(h.focusedWindows).toEqual([9]);
  expect(
    h.untrusted({ action: "focus-shared" }, { id: "installed-extension", url: consentTab.url })
      .accepted,
  ).toBeUndefined();
  h.closeTab();
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, tabMissing: true });
  expect(await h.message({ action: "focus-shared" })).toMatchObject({
    ok: false,
    error: expect.stringContaining("closed"),
  });
  expect(await h.message({ action: "stop" })).toEqual({ ok: true });
});

for (const action of ["done", "pause", "navigation", "stop"] as const) {
  test(`pending handoff attention clears on ${action} and notification focuses only shared tab`, async () => {
    const h = await setup();
    expect(await h.share()).toEqual({ ok: true });
    expect(h.badge()).toBe("");
    const handoff = h.session.handoff("Review the form").catch(() => {});
    await until(() => h.badge() === "!");
    expect(h.notification()).toBe(true);
    h.clickNotification();
    await until(() => h.focusedWindows.length === 1);
    expect(h.focusedTabs).toEqual([17]);
    expect(h.focusedWindows).toEqual([9]);
    if (action === "navigation")
      h.event("Page.frameNavigated", { frame: { id: "main", url: "https://example.test/next" } });
    else await h.message({ action });
    await until(() => h.badge() === "" && !h.notification());
    if (action !== "stop") await h.message({ action: "stop" });
    await handoff;
  });
}
