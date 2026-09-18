import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_TOOLS, BrowserPeer, PRIVATE_DELIVERY_WARNING } from "@remote-tab/client";
import type { WireMessage } from "../../protocol/src";
import { verifyChain } from "../../protocol/src/crypto";
import { createApp } from "../../server/src/app";
import { MemoryStore } from "../../server/src/memory-store";
import { defaultStatePath, parseArgs } from "./index";

const main = join(import.meta.dir, "main.ts");
const apiKey = "cli-test-platform-key-never-save";
async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    env: { ...process.env, REMOTE_TAB_SERVER_URL: "", REMOTE_TAB_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit, json: JSON.parse((exit === 0 ? stdout : stderr).trim()) };
}
function server(corrupt = () => false) {
  const store = new MemoryStore();
  const app = createApp({ store, apiKeys: new Map([["cli", apiKey]]) });
  let creates = 0;
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/sessions" && request.method === "POST") creates++;
      const response = await app.fetch(request);
      if (corrupt() && request.method === "GET" && path.endsWith("/messages")) {
        const body = await response.json();
        if (body.messages?.length) body.messages[0].hash = "f".repeat(64);
        return Response.json(body);
      }
      return response;
    },
  });
  return {
    listener,
    env: { REMOTE_TAB_SERVER_URL: listener.url.origin, REMOTE_TAB_API_KEY: apiKey },
    creates: () => creates,
  };
}

describe("CLI parser", () => {
  test("canonical vocabulary and aliases, JSON objects, and flags", () => {
    for (const tool of BROWSER_TOOLS) {
      expect(parseArgs([tool, '{"ref":"e1"}', "--timeout-ms=250"]).args).toEqual({ ref: "e1" });
      expect(parseArgs(["--state", "/private/state", tool, "--args", "{}"]).command).toBe(tool);
    }
    for (const command of ["status", "stop", "handoff"]) {
      const args = command === "handoff" ? ['{"message":"Go"}'] : [];
      expect(parseArgs([command, ...args]).command).toBe(`remote_tab_${command}`);
      expect(parseArgs([`remote_tab_${command}`, ...args]).command).toBe(`remote_tab_${command}`);
    }
    expect(parseArgs(["ledger", "export", "--out", "example"]).out).toBe("example");
    expect(parseArgs(["create", "--ttl", "3600"]).ttl).toBe(3600);
    expect(defaultStatePath({ XDG_STATE_HOME: "/private" })).toBe(
      "/private/remote-tab/session.json",
    );
    expect(defaultStatePath({ HOME: "/home/example" })).toBe(
      "/home/example/.local/state/remote-tab/session.json",
    );
  });
  test("reject malformed arguments before dispatch", () => {
    for (const args of [
      ["browser_snapshot", "[1]"],
      ["browser_snapshot", "null"],
      ["browser_snapshot", "{"],
      ["browser_click", "{}", "--args", "{}"],
      ["browser_snapshot", "--unknown"],
      ["browser_snapshot", "--state"],
      ["browser_snapshot", "--timeout-ms", "0"],
      ["browser_snapshot", "--timeout-ms", "1.5"],
      ["create", "--ttl", "59"],
      ["create", "--ttl", "3601"],
      ["status", "--ttl", "60"],
      ["status", "{}"],
      ["status", "--state", "one", "--state", "two"],
      ["handoff", "{}"],
      ["handoff", '{"message":3}'],
      ["handoff", '{"message":"","other":true}'],
      ["ledger", "export"],
      ["ledger", "render", "--out", "movie.mp4"],
      ["status", "--out", "x"],
      ["unsupported_tool"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });
  test("help needs no configuration; render gives a clear unsupported result without artifacts", async () => {
    expect((await cli(["--help"])).json.commands).toContain("remote_tab_stop");
    const directory = await mkdtemp(join(tmpdir(), "remote-tab-render-"));
    try {
      for (const format of ["gif", "webm"]) {
        const output = join(directory, `movie.${format}`);
        const rendered = await cli(["ledger", "render", "--out", output]);
        expect(rendered.exit).toBe(1);
        expect(rendered.stdout).toBe("");
        expect(rendered.json.error).toMatchObject({ code: "unsupported" });
        expect(rendered.json.error.message).toContain("M3 extension page");
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("state reserved privately before create; bad paths, flags and overwrites cannot create sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-tab-cli-"));
  const h = server();
  const state = join(root, "private", "state.json");
  try {
    const created = await cli(["create", "--state", state], h.env);
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe("");
    expect(created.json.warning).toBe(PRIVATE_DELIVERY_WARNING);
    expect(created.json.state).toBe(state);
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    const saved = await readFile(state, "utf8");
    expect(saved).not.toContain(apiKey);
    expect(Object.keys(JSON.parse(saved)).sort()).toEqual([
      "agentToken",
      "secret",
      "serverUrl",
      "sessionId",
      "v",
    ]);
    expect(created.stdout).not.toContain(JSON.parse(saved).agentToken);
    expect((await cli(["create", "--state", state], h.env)).exit).toBe(1);
    expect(await readFile(state, "utf8")).toBe(saved);
    await mkdir(join(root, "public"), { mode: 0o755 });
    const invalid = [
      ["create", "--state", join(root, "public", "state.json")],
      ["create", "--state", join(state, "child")],
      ["create", "--state", join(root, "unused"), "--ttl", "59"],
    ];
    for (const args of invalid) expect((await cli(args, h.env)).exit).toBe(1);
    await symlink(state, join(root, "link"));
    expect((await cli(["create", "--state", join(root, "link")], h.env)).exit).toBe(1);
    expect(h.creates()).toBe(1);
    const failedPath = join(root, "failed.json");
    expect(
      (await cli(["create", "--state", failedPath], { ...h.env, REMOTE_TAB_API_KEY: "wrong" }))
        .exit,
    ).toBe(1);
    expect(await Bun.file(failedPath).exists()).toBe(false);
    await chmod(state, 0o644);
    expect((await cli(["status", "--state", state])).json.error.code).toBe(
      "private_state_required",
    );
  } finally {
    h.listener.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("subprocess create → ready → snapshot + attachments → handoff → stop → verified export", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-tab-cli-e2e-"));
  let corrupt = false;
  const h = server(() => corrupt);
  const state = join(root, "session.json");
  const shared = ["--state", state, "--timeout-ms", "3000"];
  try {
    const created = await cli(["create", ...shared], h.env);
    expect(created.exit).toBe(0);
    const timeout = await cli(["wait-ready", "--state", state, "--timeout-ms", "30"]);
    expect(timeout.json.error.code).toBe("timeout");
    const browser = await BrowserPeer.redeem({
      serverUrl: h.env.REMOTE_TAB_SERVER_URL,
      code: created.json.code,
      hello: { mode: "act", scope: "https://example.test" },
      pollWaitSeconds: 0,
      pollIntervalMs: 1,
      timeoutMs: 3000,
    });
    expect((await cli(["wait-ready", ...shared])).json).toMatchObject({ mode: "act" });
    expect((await cli(["remote_tab_status", ...shared])).json.state).toBe("active");
    const commandResult = cli(["browser_snapshot", '{"ref":"e1"}', ...shared]);
    const command = await browser.nextCommand();
    expect(command).toMatchObject({ tool: "browser_snapshot", args: { ref: "e1" } });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const bytes = new TextEncoder().encode("untrusted snapshot attachment");
    await browser.sendResult(
      command.id,
      { tree: "button ref=e1" },
      {
        screenshot: { bytes: png, mimeType: "image/png" },
        blobs: [{ bytes, mimeType: "text/plain" }],
      },
    );
    const result = await commandResult;
    expect(result.json.result).toEqual({ tree: "button ref=e1" });
    expect(result.json.attachments[0].bytes).toEqual({
      encoding: "base64",
      data: Buffer.from(png).toString("base64"),
    });
    const handoff = cli(["remote_tab_handoff", '{"message":"Your turn"}', ...shared]);
    const request = await browser.nextCommand();
    expect(request).toMatchObject({ kind: "handoff", message: "Your turn" });
    await browser.handoffDone(request.id);
    expect((await handoff).json).toEqual({ ok: true });
    const failure = cli(["browser_click", "{}", ...shared]);
    const denied = await browser.nextCommand();
    await browser.sendError(denied.id, "scope_violation", "Outside shared site");
    expect((await failure).exit).toBe(1);
    expect((await cli(["stop", ...shared])).json.state).toBe("stopped");
    const out = join(root, "ledger");
    const exported = await cli(["ledger", "export", "--out", out, ...shared]);
    expect(exported.exit).toBe(0);
    const text = await readFile(join(out, "ledger.json"), "utf8");
    const ledger = JSON.parse(text);
    expect(ledger.status.state).toBe("stopped");
    const chain = await verifyChain(
      ledger.sessionId,
      ledger.entries.map((entry: { message: WireMessage }) => ({
        ...entry.message,
        prevHash: entry.message.prev_hash,
      })),
    );
    expect(chain.ok).toBe(true);
    const attachments = ledger.entries.flatMap(
      (entry: { attachments: unknown[] }) => entry.attachments,
    );
    expect(attachments).toHaveLength(2);
    expect(attachments[0].file).toMatch(/^shots\/\d+-0.png$/);
    expect(new Uint8Array(await Bun.file(join(out, attachments[0].file)).arrayBuffer())).toEqual(
      png,
    );
    expect(await readFile(join(out, attachments[1].file), "utf8")).toBe(
      new TextDecoder().decode(bytes),
    );
    const saved = JSON.parse(await readFile(state, "utf8"));
    for (const secret of [saved.secret, saved.agentToken, apiKey])
      expect(text).not.toContain(secret);
    expect((await cli(["ledger", "export", "--out", out, ...shared])).exit).toBe(1);
    expect(await readFile(join(out, "ledger.json"), "utf8")).toBe(text);
    corrupt = true;
    const broken = join(root, "broken");
    const rejected = await cli(["ledger", "export", "--out", broken, ...shared]);
    expect(rejected.exit).toBe(1);
    expect(rejected.json.error.code).toBe("chain_invalid");
    expect(await Bun.file(join(broken, "ledger.json")).exists()).toBe(false);
    await expect(stat(broken)).rejects.toThrow();
  } finally {
    h.listener.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
