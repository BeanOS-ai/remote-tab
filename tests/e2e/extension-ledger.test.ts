import { expect, test } from "bun:test";
import { type Fetch, createSession } from "@remote-tab/client";
import { MemoryStore, createApp } from "@remote-tab/server";
import { makeLedgerZip, screenshots } from "../../packages/extension/src/archive";
import { TabDriver } from "../../packages/extension/src/driver";
import { LedgerJobs, loadLedger } from "../../packages/extension/src/ledger-data";
import { SharedSession } from "../../packages/extension/src/session";
import { PNG } from "./fake-tab";

/** Real server, consent/session, crypto and transfer; only Chrome's CDP boundary is doubled. */
test("stopped extension ledger loads authenticated command/result PNGs and remains exportable after worker release", async () => {
  const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["ledger", "test-key"]]) });
  const fetch: Fetch = (request) => app.fetch(request);
  const serverUrl = "http://ledger.test";
  const quick = { timeoutMs: 2000, pollWaitSeconds: 0, pollIntervalMs: 1 };
  const created = await createSession({ serverUrl, apiKey: "test-key", fetch, ...quick });
  const hello = {
    mode: "act" as const,
    scope: "example.test",
    url: "https://example.test/form",
    title: "Ledger fixture",
  };
  let actions = 0;
  let captures = 0;
  let detached = 0;
  const driver = new TabDriver(async (method) => {
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
      case "Runtime.callFunctionOn":
        actions++;
        return { result: { value: { typed: true } } };
      case "Page.captureScreenshot":
        captures++;
        return { data: Buffer.from(PNG).toString("base64") };
      default:
        throw new Error(`Unexpected CDP command ${method}`);
    }
  }, hello);
  await driver.initialize();
  const share = await SharedSession.connect({
    ...quick,
    code: created.code,
    serverUrl,
    hello,
    driver,
    fetch,
    detach: async () => {
      detached++;
    },
  });
  const jobs = new LedgerJobs();
  let jobId: string | undefined;
  try {
    await created.session.waitReady();
    const snapshot = await created.session.send("browser_snapshot");
    const ref = (snapshot.result as { text: string }).text.match(/\[ref=(e\d+)\]/)?.[1];
    expect(ref).toBeDefined();
    const result = await created.session.send("browser_type", { ref, text: "Grace" });
    expect(result.ok).toBe(true);
    expect(result.attachments[0].bytes).toEqual(PNG);
    expect(actions).toBe(1);
    expect(captures).toBe(1);
    const stopped = share.stop();
    jobId = jobs.create(share.peer, stopped);
    let releases = 0;
    const ledger = await loadLedger(
      jobId,
      async (request) => {
        const m = request as {
          action: string;
          jobId: string;
          kind: "metadata" | "attachment";
          offset: number;
          entry?: number;
          attachment?: number;
        };
        // Chrome serializes messages as JSON. Never transfer a live typed array or key.
        let response: unknown;
        if (m.action === "ledger-status") response = jobs.status(m.jobId);
        else if (m.action === "ledger-chunk")
          response = jobs.chunk(m.jobId, m.kind, m.offset, m.entry, m.attachment);
        else if (m.action === "ledger-release") {
          releases++;
          jobs.release(m.jobId);
          response = {};
        } else throw new Error("Unexpected ledger RPC");
        return JSON.parse(JSON.stringify(response));
      },
      { pollMs: 1 },
    );
    await stopped;
    await share.settled();
    expect(detached).toBe(1);
    expect(releases).toBe(1);
    expect(jobs.status(jobId).state).toBe("error");
    expect(ledger.sessionId).toBe(share.peer.sessionId);
    expect(ledger.status.state).toBe("stopped");
    expect(ledger.entries.map((entry) => entry.envelope.kind)).toEqual([
      "hello",
      "command",
      "result",
      "command",
      "result",
    ]);
    const pair = ledger.entries.filter((entry) => entry.envelope.id === result.id);
    expect(pair.map((entry) => entry.envelope.kind)).toEqual(["command", "result"]);
    expect(ledger.status.last_seq).toBe(ledger.entries.length);
    expect(ledger.status.last_hash).toBe(ledger.entries[ledger.entries.length - 1].message.hash);
    expect(screenshots(ledger)).toEqual([{ seq: pair[1].message.seq, index: 0, bytes: PNG }]);
    const zip = makeLedgerZip(ledger);
    expect(Array.from(zip.slice(0, 4))).toEqual([80, 75, 3, 4]);
    const files = new Map<string, Uint8Array>();
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength));
      const start = offset + 30 + nameLength + extraLength;
      files.set(name, zip.slice(start, start + size));
      offset = start + size;
    }
    expect(files.get("shots/000005-0.png")).toEqual(PNG);
    const exported = JSON.parse(new TextDecoder().decode(files.get("ledger.json")));
    expect(exported.sessionId).toBe(ledger.sessionId);
    expect(exported.status).toEqual(ledger.status);
    expect(exported.entries[4].attachments[0].file).toBe("shots/000005-0.png");
    expect(JSON.stringify(exported)).not.toContain(created.code);
    expect(JSON.stringify(exported)).not.toContain(created.session.exportState().agentToken);
  } finally {
    if (jobId) jobs.release(jobId);
    await share.stop();
    await share.settled();
  }
});
