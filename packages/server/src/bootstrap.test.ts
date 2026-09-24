import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { version } from "../../../npm/remote-tab/package.json" with { type: "json" };
import { createApp } from "./app";
import { ORIGIN_PLACEHOLDER, parsePublicOrigin } from "./bootstrap";
import { serverPolicy } from "./config";
import { MemoryStore } from "./memory-store";

const app = createApp({ store: new MemoryStore(), anonymousQps: 10000 });
const request = (path: string, method = "GET") =>
  app.fetch(new Request(`https://server.invalid${path}`, { method }));

test("docs are a short CLI quick start that links the repository", async () => {
  const res = await request("/docs");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/markdown");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const text = await res.text();
  // Gilad, 2026-09-24: /docs was "too verbose"; the protocol reference lives in the repo.
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4_000);
  for (const phrase of [
    `npx -y remote-tab@${version} create`,
    `npx -y remote-tab@${version} wait-ready`,
    `npx -y remote-tab@${version} stop`,
    `npx -y remote-tab@${version} status`,
    "do not print or log it",
    "Read my tab",
    `npx -y remote-tab@${version} skill`,
    `"remote-tab@${version}","remote-tab-mcp"`,
    "private channel",
    "untrusted data",
    "handoff",
    "https://github.com/BeanOS-ai/remote-tab",
  ]) {
    expect(text).toContain(phrase);
  }
  expect(text).not.toContain("client-code");
});

test("a configured public origin names the relay in the docs", async () => {
  const origin = "https://tab.example";
  const configured = createApp({
    store: new MemoryStore(),
    anonymousQps: 10000,
    publicOrigin: `${origin}/`,
  });
  const get = async (path: string) =>
    (await configured.fetch(new Request(`https://attacker.invalid${path}`))).text();
  const docs = await get("/docs");
  expect(docs).toContain(`export REMOTE_TAB_SERVER_URL=${origin}\n`);
  expect(docs).toContain(`"REMOTE_TAB_SERVER_URL":"${origin}"`);
  expect(docs).not.toContain(ORIGIN_PLACEHOLDER);
  expect(docs).not.toContain("attacker.invalid");
});

test("public origin configuration accepts only a plain http(s) origin", () => {
  expect(parsePublicOrigin(undefined)).toBeUndefined();
  expect(parsePublicOrigin("")).toBeUndefined();
  expect(parsePublicOrigin("https://tab.beanos.ai/")).toBe("https://tab.beanos.ai");
  expect(parsePublicOrigin("http://localhost:8080")).toBe("http://localhost:8080");
  for (const value of [
    "tab.beanos.ai",
    "https://tab.beanos.ai/docs",
    "https://tab.beanos.ai?x=1",
    "https://user@tab.beanos.ai",
    "ftp://tab.beanos.ai",
    "javascript:alert(1)",
    'https://a"b.example',
    "https://a$(id).example",
    "https://a`id`.example",
    "https://TAB.example",
  ]) {
    expect(() => parsePublicOrigin(value)).toThrow("REMOTE_TAB_PUBLIC_ORIGIN");
  }
  expect(serverPolicy({ REMOTE_TAB_PUBLIC_ORIGIN: "https://tab.example" }).publicOrigin).toBe(
    "https://tab.example",
  );
  expect(() => serverPolicy({ REMOTE_TAB_PUBLIC_ORIGIN: "https://tab.example/x" })).toThrow();
});

test("unknown sources, browser pages, traversal, and non-GET methods stay 404", async () => {
  for (const path of [
    "/",
    "/index.html",
    "/docs/",
    "/client-code",
    "/client-code/",
    "/client-code/packages/protocol/src/index.ts",
    "/client-code/packages/cli/package.json",
    "/client-code/../../package.json",
    "/client-code/%2e%2e/%2e%2e/package.json",
  ]) {
    expect((await request(path)).status).toBe(404);
  }
  for (const path of ["/docs"]) {
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
    const docs = await isolated.fetch(new Request("https://server.invalid/docs"));
    expect(await docs.text()).toBe(await (await request("/docs")).text());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
