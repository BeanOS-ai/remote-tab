import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./app";
import { MemoryStore } from "./memory-store";

const app = createApp({ store: new MemoryStore(), anonymousQps: 10000 });
const request = (path: string, method = "GET") =>
  app.fetch(new Request(`https://server.invalid${path}`, { method }));

test("agent docs are generated markdown with the custody caveat and all APIs", async () => {
  const res = await request("/docs");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/markdown");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const text = await res.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40_000);
  expect(text).toContain("trusts that server's operator with the complete shared session");
  for (const phrase of [
    "Create needs no Authorization header on an open deployment",
    "rate_limited",
    "REMOTE_TAB_ANONYMOUS_QPS",
    "key_service_unavailable",
    "Authorization: Bearer",
    "HKDF",
    "AES-256-GCM",
    "handoff_done",
    "private",
    "key_hex",
    "browser_click",
    "/extend",
    "/stop",
    "/blobs",
    "/redeem",
    "/messages",
  ]) {
    expect(text).toContain(phrase);
  }
});

test("source index hashes and byte counts match both downloads and repository files", async () => {
  const res = await request("/client-code");
  expect(res.headers.get("content-type")).toStartWith("application/json");
  const index = (await res.json()) as {
    version: string;
    files: { path: string; sha256: string; bytes: number }[];
  };
  expect(index.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(index.files.length).toBeGreaterThan(0);
  const paths = new Set<string>();
  for (const file of index.files) {
    expect(Object.keys(file).sort()).toEqual(["bytes", "path", "sha256"]);
    expect(file.path).toMatch(/^packages\/(protocol|client|cli)\/(src\/.*\.ts|package\.json)$/);
    expect(file.path).not.toMatch(/node_modules|\.test\.|\.spec\.|\.\./);
    expect(paths.has(file.path)).toBe(false);
    paths.add(file.path);
    const response = await request(`/client-code/${file.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    expect(bytes).toEqual(await readFile(resolve(import.meta.dir, "../../..", file.path)));
  }
});

test("unknown sources, browser pages, traversal, and non-GET methods stay 404", async () => {
  for (const path of [
    "/",
    "/index.html",
    "/docs/",
    "/client-code/",
    "/client-code/__proto__",
    "/client-code/constructor",
    "/client-code/packages/server/src/main.ts",
    "/client-code/packages/protocol/src/crypto.test.ts",
    "/client-code/../../package.json",
    "/client-code/%2e%2e/%2e%2e/package.json",
    "/client-code/packages%2fprotocol%2fsrc%2findex.ts",
    "/client-code/packages/protocol/src/index.ts%00",
    "/client-code/packages/protocol/src/..%5c..%5cserver/src/main.ts",
  ]) {
    expect((await request(path)).status).toBe(404);
  }
  for (const path of ["/docs", "/client-code", "/client-code/packages/protocol/src/index.ts"]) {
    expect((await request(path, "POST")).status).toBe(404);
  }
});

test("bundled app serves embedded assets from an isolated output directory", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(`${tmpdir()}/remote-tab-bundle-`);
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "app.ts")],
      outdir: directory,
      target: "bun",
    });
    expect(build.success).toBe(true);
    const { createApp: bundledApp } = await import(resolve(directory, "app.js"));
    const isolated = bundledApp({ store: new MemoryStore(), anonymousQps: 10000 });
    const index = await isolated.fetch(new Request("https://server.invalid/client-code"));
    expect(await index.json()).toEqual(await (await request("/client-code")).json());
    const docs = await isolated.fetch(new Request("https://server.invalid/docs"));
    expect(await docs.text()).toBe(await (await request("/docs")).text());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloaded client and CLI source run without registry access", async () => {
  const { mkdtemp, mkdir, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const directory = await mkdtemp(`${tmpdir()}/remote-tab-download-`);
  try {
    const index = (await (await request("/client-code")).json()) as {
      files: { path: string }[];
    };
    for (const { path } of index.files) {
      const file = join(directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await (await request(`/client-code/${path}`)).text());
    }
    const scope = join(directory, "node_modules/@remote-tab");
    await mkdir(scope, { recursive: true });
    for (const name of ["protocol", "client", "cli"]) {
      await symlink(`../../packages/${name}`, join(scope, name));
    }
    const entry = join(directory, "smoke.ts");
    await writeFile(
      entry,
      'import { createSession, BrowserPeer } from "@remote-tab/client";\n' +
        'if (typeof createSession !== "function" || typeof BrowserPeer !== "function") process.exit(1);\n',
    );
    const child = Bun.spawn([process.execPath, "--no-install", entry], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const cli = Bun.spawn(
      [process.execPath, "--no-install", join(directory, "packages/cli/src/main.ts"), "--help"],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [help, errors, exit] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect(exit, errors).toBe(0);
    expect(help).toContain("ledger");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
