import { expect, test } from "bun:test";
import { serverOrigin } from "./build";

test("distribution origin defaults to a placeholder and never accepts credentials or paths", () => {
  expect(serverOrigin()).toBe("https://remote-tab.example");
  expect(serverOrigin("https://example.test:8443/")).toBe("https://example.test:8443");
  expect(serverOrigin("http://127.0.0.1:4567")).toBe("http://127.0.0.1:4567");
  for (const origin of [
    "http://example.test",
    "https://name:password@example.test",
    "https://example.test/path",
    "https://example.test/?secret=value",
    "https://example.test/#fragment",
    "file:///tmp/file",
    "https://*.example.test/",
  ]) {
    expect(() => serverOrigin(origin)).toThrow();
  }
});

test("browser bundle and manifest share one origin with no broad or legacy hosts", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildExtension } = await import("./build");
  const out = await mkdtemp(join(tmpdir(), "remote-tab-build-"));
  try {
    await buildExtension("https://configured.example", out);
    const manifest = await Bun.file(`${out}/manifest.json`).json();
    expect(manifest.name).toBe("Bean Tab Share");
    expect(manifest.version).toBe(
      (await Bun.file(`${import.meta.dir}/package.json`).json()).version,
    );
    expect(manifest.permissions).toEqual(["tabs", "debugger"]);
    expect(manifest.icons).toEqual({
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(manifest.host_permissions).toEqual(["https://configured.example/*"]);
    expect(manifest.background).toEqual({ service_worker: "worker.js", type: "module" });
    expect(manifest.minimum_chrome_version).toBe("125");
    const worker = await Bun.file(`${out}/worker.js`).text();
    expect(worker).toContain("https://configured.example");
    expect(worker).not.toContain("https://remote-tab.example");
    expect(worker).not.toContain("storage.googleapis.com");
    expect(/(?:from|import)\s*["\']node:/.test(worker)).toBe(false);
    for (const file of [
      "popup.js",
      "bean-creature.svg",
      "ledger.js",
      "ledger.html",
      "ledger.css",
      "icons/icon16.png",
      "icons/icon48.png",
      "icons/icon128.png",
      "LICENSE",
      "vendor/PSL-LICENSE",
      "vendor/README.md",
      "vendor/public-suffix-rules.json",
    ])
      expect(await Bun.file(`${out}/${file}`).exists()).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
