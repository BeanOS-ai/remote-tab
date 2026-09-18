import { afterEach, expect, test } from "bun:test";
import { type Fetch, createSession } from "@remote-tab/client";
import { until } from "../../../tests/e2e/fake-tab";
import { createApp } from "../../server/src/app";
import { MemoryStore } from "../../server/src/memory-store";
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

async function setup(hold?: "redeem" | "status", sensitiveValue?: string) {
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
  const cdpCalls: { method: string; params: Record<string, unknown> }[] = [];
  let holdNextWrite = false;
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
    humanInput: () => {
      const binding = cdpCalls.find((call) => call.method === "Runtime.addBinding");
      if (!binding) throw new Error("Takeover binding has not been installed");
      onEvent({ tabId: consentTab.id }, "Runtime.executionContextCreated", {
        context: {
          id: 123,
          name: binding.params.executionContextName,
          auxData: { isDefault: false },
        },
      });
      onEvent({ tabId: consentTab.id }, "Runtime.bindingCalled", {
        name: binding.params.name,
        executionContextId: 123,
        payload: JSON.stringify({ type: "keydown", key: "x", modifiers: 0 }),
      });
    },
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
    for (const action of ["state", "stop", "resume", "done", "extend", "share"]) {
      const response = h.untrusted({ action, code: h.code }, source);
      expect(response.accepted).toBeUndefined();
      expect(response.responded()).toBe(false);
    }
  }
  expect(h.requests.slice(before).filter((request) => request.method === "POST")).toHaveLength(0);
  expect(h.detached).toHaveLength(0);
  expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, extended: false });
});

for (const phase of ["redeem", "status"] as const) {
  test(`trusted human input during deferred ${phase} starts paused and requires explicit Resume`, async () => {
    const h = await setup(phase);
    const pending = h.share();
    await h.reached.promise;
    h.humanInput();
    h.release.resolve();
    expect(await pending).toEqual({ ok: true });
    expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, paused: true });
    const before = h.cdpCalls.length;
    expect(await h.session.send("browser_snapshot", {}, { timeoutMs: 2000 })).toMatchObject({
      ok: false,
      error: { code: "paused" },
    });
    expect(h.cdpCalls).toHaveLength(before);
    expect(await h.message({ action: "resume" })).toEqual({ ok: true });
    expect(await h.message({ action: "state" })).toMatchObject({ sharing: true, paused: false });
  });
}

test("paused human navigation still resolves Fetch interception while agent actions stay denied", async () => {
  const h = await setup();
  expect(await h.share()).toEqual({ ok: true });
  h.humanInput();
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

test("human input while Done is awaiting delivery preserves the new takeover pause", async () => {
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
  h.humanInput();
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
