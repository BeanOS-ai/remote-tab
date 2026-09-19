import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, type LedgerEntry, PRIVATE_DELIVERY_WARNING } from "@remote-tab/client";
import { verifyChain } from "@remote-tab/protocol/src/crypto";
import { MemoryStore, createApp } from "@remote-tab/server";
import { FakeTab, HELLO, PNG, until } from "./fake-tab";

test("CLI and a driven fake tab complete the human share workflow and export a verified ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-tab-e2e-"));
  const state = join(root, "state.json");
  const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["e2e", "test-key"]]) });
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request),
  });
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  let tab: FakeTab | undefined;
  const cli = async (args: string[], create = false) => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(import.meta.resolve("@remote-tab/cli/src/main.ts")),
        ...args,
        "--state",
        state,
        "--timeout-ms",
        "5000",
      ],
      {
        env: {
          ...process.env,
          REMOTE_TAB_SERVER_URL: create ? listener.url.origin : "",
          REMOTE_TAB_API_KEY: create ? "test-key" : "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.add(child);
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (!stdout && !stderr)
        throw new Error("CLI exited without a JSON result (possibly timed out)");
      expect(exit === 0 ? stderr : stdout).toBe("");
      return { exit, data: JSON.parse(exit === 0 ? stdout : stderr) };
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  };
  const ok = async (args: string[]) => {
    const result = await cli(args);
    expect(result.exit).toBe(0);
    return result.data;
  };
  try {
    const created = await cli(["create"], true);
    expect(created.exit).toBe(0);
    expect(created.data.code).toMatch(/^rt1\.[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(created.data.code).toHaveLength(26);
    expect(created.data.warning).toBe(PRIVATE_DELIVERY_WARNING);
    expect((await ok(["status"])).state).toBe("created");
    tab = await FakeTab.redeem({
      serverUrl: listener.url.origin,
      code: created.data.code,
      pollWaitSeconds: 0,
      pollIntervalMs: 1,
    });
    expect(await ok(["wait-ready"])).toEqual(HELLO);
    expect((await ok(["browser_snapshot"])).result.nodes[0]).toMatchObject({
      ref: "name",
      value: "",
    });
    const typed = await ok(["browser_type", JSON.stringify({ ref: "name", text: "Ada" })]);
    const clicked = await ok(["browser_click", JSON.stringify({ ref: "submit" })]);
    for (const result of [typed, clicked])
      expect(result.attachments[0].bytes.data).toBe(Buffer.from(PNG).toString("base64"));
    expect((await ok(["browser_snapshot"])).result.nodes[2]).toMatchObject({
      ref: "result",
      text: "Submitted: Ada",
    });
    expect((await ok(["browser_take_screenshot"])).attachments[0].bytes.data).toBe(
      Buffer.from(PNG).toString("base64"),
    );
    let completed = false;
    const handoff = cli(["handoff", JSON.stringify({ message: "Approve the form" })]).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    await until(() => tab?.handoffMessage === "Approve the form");
    const before = tab.executed.length;
    const blocked = await cli(["browser_snapshot"]);
    expect(blocked.exit).toBe(1);
    expect(blocked.data.error.code).toBe("handoff_pending");
    expect(tab.executed.length).toBe(before);
    expect(completed).toBe(false);
    await tab.done();
    expect((await handoff).exit).toBe(0);
    expect((await ok(["status"])).hello).toEqual(HELLO);
    expect((await ok(["stop"])).state).toBe("stopped");
    await until(() => tab?.terminal === "stopped");
    const stopped = await cli(["browser_click", '{"ref":"submit"}']);
    expect(stopped.exit).toBe(1);
    expect(stopped.data.error.code).toBe("session_not_active");
    expect(tab.executed.length).toBe(before);
    const out = join(root, "export");
    await ok(["ledger", "export", "--out", out]);
    const ledger = JSON.parse(await readFile(join(out, "ledger.json"), "utf8"));
    expect(ledger.status.state).toBe("stopped");
    expect(
      (
        await verifyChain(
          ledger.sessionId,
          ledger.entries.map((entry: LedgerEntry) => ({
            ...entry.message,
            prevHash: entry.message.prev_hash,
          })),
        )
      ).ok,
    ).toBe(true);
    expect(ledger.entries.map((entry: LedgerEntry) => entry.envelope.kind)).toEqual([
      "hello",
      "command",
      "result",
      "command",
      "result",
      "command",
      "result",
      "command",
      "result",
      "command",
      "result",
      "handoff",
      "handoff_done",
    ]);
    for (let i = 1; i <= 9; i += 2)
      expect(ledger.entries[i].envelope.id).toBe(ledger.entries[i + 1].envelope.id);
    expect(ledger.entries[11].envelope.id).toBe(ledger.entries[12].envelope.id);
    const shots = ledger.entries.flatMap(
      (entry: { attachments: { file: string }[] }) => entry.attachments,
    );
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(shot.file).toMatch(/^shots\/[\d-]+\.png$/);
      expect(new Uint8Array(await Bun.file(join(out, shot.file)).arrayBuffer())).toEqual(PNG);
    }
    const saved = JSON.parse(await readFile(state, "utf8"));
    const resumed = AgentSession.resume(saved);
    expect((await resumed.ledger()).entries.length).toBe(ledger.entries.length);
    const exported = JSON.stringify(ledger);
    for (const secret of [saved.secret, saved.agentToken, "test-key"])
      expect(exported).not.toContain(secret);
  } finally {
    for (const child of children) child.kill();
    await Promise.all([...children].map((child) => child.exited));
    try {
      await tab?.close();
    } finally {
      listener.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
}, 20000);
