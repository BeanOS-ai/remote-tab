import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp as sourceCreateApp } from "./app";
import { MemoryStore } from "./memory-store";
import { ChainMismatch, RateLimited, SessionIdTaken, SessionNotActive } from "./store";

test("bundled HTTP handlers recognize independently loaded adapter errors and typed fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-tab-store-bundle-"));
  try {
    // A fresh compiler avoids Bun's in-process build cache colliding with
    // modules already imported by the full test suite.
    const compiler = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        join(import.meta.dir, "app.ts"),
        "--target=bun",
        "--outdir",
        directory,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, diagnostics] = await Promise.all([
      compiler.exited,
      new Response(compiler.stderr).text(),
      new Response(compiler.stdout).text(),
    ]);
    expect(diagnostics).toBe("");
    expect(exit).toBe(0);
    const { createApp } = (await import(join(directory, "app.js"))) as {
      createApp: typeof sourceCreateApp;
    };
    const store = new MemoryStore();
    const app = createApp({ store, anonymousQps: 100, usageSink: { record() {} } });
    const call = (path: string, token?: string, body?: unknown) =>
      app.fetch(
        new Request(`https://server.invalid${path}`, {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      );
    const id = "a".repeat(32);
    const created = await call("/v1/sessions", undefined, { id });
    expect(created.status).toBe(201);
    const { agent_token } = await created.json();
    expect((await call(`/v1/sessions/${id}/redeem`)).status).toBe(200);

    // These constructors are loaded from source, separately from the bundle.
    const create = store.createSession.bind(store);
    for (const [error, status, code] of [
      [new SessionIdTaken(), 409, "id_taken"],
      [new RateLimited(7), 429, "rate_limited"],
    ] as const) {
      store.createSession = async () => {
        throw error;
      };
      const response = await call("/v1/sessions", undefined, { id: "b".repeat(32) });
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(code);
      if (error instanceof RateLimited) expect(response.headers.get("retry-after")).toBe("7");
    }
    store.createSession = create;
    for (const [error, code] of [
      [new SessionNotActive(), "session_not_active"],
      [new ChainMismatch("f".repeat(64)), "chain_mismatch"],
    ] as const) {
      store.appendMessage = async () => {
        throw error;
      };
      const response = await call(`/v1/sessions/${id}/messages`, agent_token, {
        role: "agent",
        prev_hash: "",
        nonce: "A".repeat(16),
        ciphertext: "A".repeat(22),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe(code);
      if (error instanceof ChainMismatch) expect(body.expected_prev_hash).toBe("f".repeat(64));
    }
    // A plugin cannot accidentally become a domain error merely by reusing its name.
    const ordinary = new Error("ordinary");
    ordinary.name = "SessionIdTaken";
    expect(ordinary instanceof SessionIdTaken).toBe(false);
    expect(new SessionNotActive() instanceof SessionIdTaken).toBe(false);
    expect(new ChainMismatch("head") instanceof RateLimited).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
