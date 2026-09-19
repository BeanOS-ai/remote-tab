import { expect, test } from "bun:test";
import { type Fetch, createSession } from "@remote-tab/client";
import { MemoryStore, createApp } from "@remote-tab/server";
import { TabDriver } from "../../packages/extension/src/driver";
import { SharedSession } from "../../packages/extension/src/session";
import { StaticKeyResolver } from "../../packages/server/src/key-resolver";
import { PNG, until } from "./fake-tab";

const serverUrl = "http://controls.test";
const quick = { timeoutMs: 2000, pollWaitSeconds: 0, pollIntervalMs: 1 };
const hello = {
  mode: "act" as const,
  scope: "example.test",
  url: "https://example.test/form",
  title: "Controls fixture",
};
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Only Chrome commands are doubled; consent, control loop and encrypted transport are real. */
async function fixture() {
  const app = createApp({
    store: new MemoryStore(),
    keyResolver: new StaticKeyResolver(new Map([["controls", "test-key"]]), { defaultQps: 0 }),
    anonymousQps: 0,
  });
  const fetch: Fetch = (request) => app.fetch(request);
  const created = await createSession({ serverUrl, apiKey: "test-key", fetch, ...quick });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const barriers: { screenshot?: ReturnType<typeof gate>; stop?: ReturnType<typeof gate> } = {};
  let value = "";
  let screenshots = 0;
  let stopRequests = 0;
  let detached = 0;
  const driver = new TabDriver(async (method, params = {}) => {
    calls.push({ method, params });
    if (
      method.endsWith(".enable") ||
      method === "Page.setLifecycleEventsEnabled" ||
      method === "Runtime.releaseObject"
    )
      return {};
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", url: hello.url } } };
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "input",
              backendDOMNodeId: 10,
              role: { value: "textbox" },
              name: { value: "Name" },
            },
          ],
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 1 };
      case "DOM.resolveNode":
        return { object: { objectId: "input" } };
      case "Runtime.callFunctionOn": {
        const args = params.arguments as { value: unknown }[];
        if (args[0].value !== "type") throw new Error("Unexpected node helper");
        value = String(args[1].value);
        return { result: { value: { typed: true } } };
      }
      case "Page.captureScreenshot":
        screenshots++;
        await barriers.screenshot?.promise;
        return { data: Buffer.from(PNG).toString("base64") };
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  }, hello);
  await driver.initialize();
  const browserFetch: Fetch = async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/stop")) {
      stopRequests++;
      await barriers.stop?.promise;
    }
    return fetch(request);
  };
  const share = await SharedSession.connect({
    ...quick,
    code: created.code,
    serverUrl,
    hello,
    driver,
    fetch: browserFetch,
    detach: async () => {
      detached++;
    },
  });
  await created.session.waitReady();
  return {
    agent: created.session,
    share,
    calls,
    barriers,
    fetch,
    value: () => value,
    screenshots: () => screenshots,
    stopRequests: () => stopRequests,
    detached: () => detached,
    close: async () => {
      barriers.screenshot?.release();
      barriers.stop?.release();
      await share.stop();
      await share.settled();
    },
  };
}
async function inputRef(h: Awaited<ReturnType<typeof fixture>>) {
  const result = await h.agent.send("browser_snapshot");
  expect(result.ok).toBe(true);
  const ref = (result.result as { text: string }).text.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref) throw new Error("Snapshot did not expose input ref");
  return ref;
}

test("human pause denies queued browser commands before CDP; status and resume remain available", async () => {
  const h = await fixture();
  try {
    h.share.pause();
    expect(h.share.state.paused).toBe(true);
    const before = h.calls.length;
    const denied = await h.agent.send("browser_snapshot");
    expect(denied).toMatchObject({ ok: false, error: { code: "paused" } });
    expect(denied.attachments).toHaveLength(0);
    expect(h.calls).toHaveLength(before);
    const status = await h.agent.send("remote_tab_status");
    expect(status).toMatchObject({ ok: true, result: { mode: "act", paused: true } });
    expect(h.calls).toHaveLength(before);
    h.share.resume();
    expect(h.share.state.paused).toBe(false);
    expect((await h.agent.send("browser_snapshot")).ok).toBe(true);
    expect(h.calls.length).toBeGreaterThan(before);
  } finally {
    await h.close();
  }
});

test("agent handoff exposes the message and blocks queued commands until human Done", async () => {
  const h = await fixture();
  try {
    let handedBack = false;
    let followupFinished = false;
    const handoff = h.agent.handoff("Please complete the confirmation").then(() => {
      handedBack = true;
    });
    await until(() => h.share.state.handoff !== undefined);
    expect(h.share.state.handoff?.message).toBe("Please complete the confirmation");
    const handoffId = h.share.state.handoff?.id;
    expect(handoffId).toBeTruthy();
    expect(() => h.share.resume()).toThrow("Done");
    const before = h.calls.length;
    const followup = h.agent.send("browser_snapshot").then((result) => {
      followupFinished = true;
      return result;
    });
    await Bun.sleep(25);
    expect(handedBack).toBe(false);
    expect(followupFinished).toBe(false);
    expect(h.calls).toHaveLength(before);
    await h.share.done();
    await handoff;
    expect((await followup).ok).toBe(true);
    expect(h.share.state.handoff).toBeUndefined();
    const entries = (await h.agent.ledger()).entries;
    expect(
      entries
        .filter((entry) => entry.envelope.id === handoffId)
        .map((entry) => entry.envelope.kind),
    ).toEqual(["handoff", "handoff_done"]);
    expect(entries.findIndex((entry) => entry.envelope.kind === "handoff_done")).toBeLessThan(
      entries.findIndex((entry) => entry.envelope.kind === "command"),
    );
  } finally {
    await h.close();
  }
});

test("agent stop remains terminal while the human has paused sharing", async () => {
  const h = await fixture();
  try {
    h.share.pause();
    const before = h.calls.length;
    await h.agent.stop();
    await until(() => h.detached() === 1);
    await h.share.settled();
    expect(h.share.state.sharing).toBe(false);
    expect(h.calls).toHaveLength(before);
    expect((await h.agent.status()).state).toBe("stopped");
  } finally {
    await h.close();
  }
});

test("only the browser can extend once, with updated visible expiry and the server TTL cap", async () => {
  const h = await fixture();
  try {
    const initial = h.share.state.expiresAt;
    expect(h.share.state.extended).toBe(false);
    const state = h.agent.exportState();
    const rejected = await h.fetch(
      new Request(`${serverUrl}/v1/sessions/${state.sessionId}/extend`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.agentToken}` },
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "unauthorized" });
    const command = await h.agent.send("remote_tab_extend");
    expect(command.ok).toBe(false);
    expect(h.share.state.expiresAt).toBe(initial);
    await h.share.extend();
    expect(h.share.state.extended).toBe(true);
    const extended = h.share.state.expiresAt;
    if (!initial || !extended) throw new Error("Sharing must expose initial and extended expiry");
    expect(Date.parse(extended) - Date.parse(initial)).toBe(1800_000);
    expect((await h.agent.status()).expires_at).toBe(extended);
    await expect(h.share.extend()).rejects.toThrow();
    await expect(h.share.peer.extend()).rejects.toMatchObject({ code: "ttl_exceeded" });
  } finally {
    await h.close();
  }
});

test("stop detaches immediately while the server stop response is blocked, including while paused", async () => {
  const h = await fixture();
  try {
    h.share.pause();
    h.barriers.stop = gate();
    let stopFinished = false;
    const stopped = h.share.stop().then(() => {
      stopFinished = true;
    });
    await until(() => h.stopRequests() === 1);
    expect(h.detached()).toBe(1);
    expect(h.share.state.sharing).toBe(false);
    expect(stopFinished).toBe(false);
    const before = h.calls.length;
    expect(() => h.share.resume()).toThrow("Sharing has ended");
    expect(h.share.state.sharing).toBe(false);
    expect(h.calls).toHaveLength(before);
    h.barriers.stop.release();
    await stopped;
    await h.share.settled();
    expect((await h.agent.status()).state).toBe("stopped");
    await expect(h.agent.send("browser_snapshot")).rejects.toMatchObject({
      code: "session_not_active",
    });
    await h.share.stop();
    expect(h.detached()).toBe(1);
  } finally {
    await h.close();
  }
});

for (const resumeBeforeCompletion of [false, true]) {
  test(`pause during an active action suppresses stale success and screenshot (resumed before completion: ${resumeBeforeCompletion})`, async () => {
    const h = await fixture();
    try {
      const ref = await inputRef(h);
      h.barriers.screenshot = gate();
      const action = h.agent.send("browser_type", { ref, text: "private in-flight text" });
      await until(() => h.screenshots() === 1);
      expect(h.value()).toBe("private in-flight text");
      h.share.pause();
      if (resumeBeforeCompletion) {
        h.share.resume();
        expect(h.share.state.paused).toBe(false);
      }
      h.barriers.screenshot.release();
      const result = await action;
      expect(result).toMatchObject({ ok: false, error: { code: "paused" } });
      expect(result.screenshot).toBeUndefined();
      expect(result.result).toBeUndefined();
      expect(result.attachments).toHaveLength(0);
      const pair = (await h.agent.ledger()).entries.filter(
        (entry) => entry.envelope.id === result.id,
      );
      expect(pair.map((entry) => entry.envelope.kind)).toEqual(["command", "result"]);
      expect(pair[1].attachments).toHaveLength(0);
      expect(h.calls.filter((call) => call.method === "Runtime.callFunctionOn")).toHaveLength(1);
      h.share.resume();
      expect((await h.agent.send("browser_snapshot")).ok).toBe(true);
      expect(h.calls.filter((call) => call.method === "Runtime.callFunctionOn")).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
}

test("recent action summaries describe the operation without echoing typed content or raw arguments", async () => {
  const h = await fixture();
  try {
    const ref = await inputRef(h);
    const before = h.share.state.actions.length;
    const text = "private typed payload 9137";
    const result = await h.agent.send("browser_type", { ref, text });
    expect(result.ok).toBe(true);
    expect(h.value()).toBe(text);
    expect(h.share.state.actions.length).toBeGreaterThan(before);
    const summaries = h.share.state.actions.join("\n");
    expect(summaries).not.toContain(text);
    expect(summaries).not.toContain(ref);
    expect(summaries).not.toContain("browser_type");
    expect(
      h.share.state.actions.every((summary) => typeof summary === "string" && summary.length > 0),
    ).toBe(true);
  } finally {
    await h.close();
  }
});
