// Independently unzip and load the exact Web Store artifact in real Chromium.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/store-package-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageStore } from "../packages/extension/package-store.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const scratch = await mkdtemp(join(tmpdir(), "remote-tab-store-smoke-"));
const origin = "https://store-package.example:8443";
let context;
try {
  const zip = await packageStore({ origin, output: join(scratch, "store.zip") });
  const list = Bun.spawnSync(["unzip", "-Z1", zip]);
  assert.equal(list.exitCode, 0, new TextDecoder().decode(list.stderr));
  const names = new TextDecoder().decode(list.stdout).trim().split("\n");
  assert.equal(new Set(names).size, names.length, "Archive entries must be unique");
  for (const name of names) {
    assert.ok(!name.startsWith("/") && !name.includes("\\") && !name.split("/").includes(".."));
    assert.ok(!name.endsWith(".map") && !name.includes("node_modules/"));
  }
  const unpacked = join(scratch, "unpacked");
  const unzip = Bun.spawnSync(["unzip", "-q", zip, "-d", unpacked]);
  assert.equal(unzip.exitCode, 0, new TextDecoder().decode(unzip.stderr));
  const manifest = await Bun.file(join(unpacked, "manifest.json")).json();
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Bean Tab Share");
  assert.equal(manifest.version, "2.1.0");
  assert.deepEqual([...manifest.permissions].sort(), ["debugger", "tabs"]);
  assert.deepEqual(manifest.host_permissions, [`${origin}/*`]);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'",
  );
  for (const name of [
    "manifest.json",
    "worker.js",
    "popup.html",
    "popup.js",
    "style.css",
    "bean-creature.svg",
    "ledger.html",
    "ledger.js",
    "ledger.css",
    "LICENSE",
    "vendor/PSL-LICENSE",
    "vendor/README.md",
    "vendor/public-suffix-rules.json",
  ]) {
    assert.ok(names.includes(name), `Required store archive file missing: ${name}`);
    assert.ok((await Bun.file(join(unpacked, name)).arrayBuffer()).byteLength > 0);
  }
  const workerSource = await Bun.file(join(unpacked, manifest.background.service_worker)).text();
  assert.ok(workerSource.includes(origin));
  assert.ok(!workerSource.includes("https://remote-tab.example"));
  for (const size of [16, 48, 128]) {
    assert.equal(typeof manifest.icons[size], "string");
    assert.ok(names.includes(manifest.icons[size]));
  }
  context = await chromium.launchPersistentContext(join(scratch, "profile"), {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
  });
  context.setDefaultTimeout(10000);
  const externalRequests = [];
  await context.route(/^https?:/, (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const installedId = new URL(worker.url()).hostname;
  const installedManifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.deepEqual(installedManifest.permissions.sort(), ["debugger", "tabs"]);
  assert.deepEqual(installedManifest.host_permissions, [`${origin}/*`]);
  const grantedPermissions = await worker.evaluate(() => chrome.permissions.getAll());
  assert.deepEqual(grantedPermissions.permissions.sort(), ["debugger", "tabs"]);
  assert.deepEqual(grantedPermissions.origins, [`${origin}/*`]);
  assert.equal(await worker.evaluate(() => typeof chrome.debugger.attach), "function");
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${installedId}/popup.html`);
  await popup.locator("#share").waitFor();
  assert.equal(await popup.locator("#stop").isDisabled(), true);
  assert.equal(await popup.locator("#consent").isVisible(), true);
  assert.equal(await popup.locator('script[src="popup.js"]').count(), 1);
  assert.equal(await popup.evaluate(() => document.styleSheets.length), 1);
  assert.equal(
    await popup
      .locator('img[src="bean-creature.svg"]')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  assert.equal(await popup.locator('a[href="https://beanos.ai/remote-tab"]').count(), 1);
  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "state" }));
  assert.equal(state.sharing, false, "Installed popup must reach its worker");
  await popup.locator("#code").fill("rt1.invalid");
  await popup.locator("#share").click();
  assert.equal(
    await popup.locator("#error").textContent(),
    "Paste a valid rt1. code from your agent",
  );
  const dimensions = await popup.evaluate(async (icons) => {
    const output = [];
    for (const [size, path] of Object.entries(icons)) {
      const image = new Image();
      image.src = chrome.runtime.getURL(path);
      await image.decode();
      output.push([Number(size), image.naturalWidth, image.naturalHeight]);
    }
    return output;
  }, manifest.icons);
  for (const [size, width, height] of dimensions) {
    assert.equal(width, size);
    assert.equal(height, size);
  }
  const ledger = await context.newPage();
  const jobId = crypto.randomUUID();
  await ledger.goto(`chrome-extension://${installedId}/ledger.html#${jobId}`);
  await ledger.locator('#status[data-state="error"]').waitFor();
  assert.equal(await ledger.locator("#download-zip").isDisabled(), true);
  assert.equal(await ledger.locator("#render-gif").isDisabled(), true);
  assert.equal(await ledger.locator('script[src="ledger.js"]').count(), 1);
  assert.equal(await ledger.evaluate(() => document.styleSheets.length), 1);
  const status = await ledger.evaluate(
    (id) => chrome.runtime.sendMessage({ action: "ledger-status", jobId: id }),
    jobId,
  );
  assert.equal(
    status.code,
    "ledger_unavailable",
    "Exact installed ledger URL must reach worker with hash intact",
  );
  const denied = async (id) => {
    try {
      return await chrome.runtime.sendMessage({ action: "ledger-status", jobId: id });
    } catch {
      return undefined;
    }
  };
  assert.equal(
    await ledger.evaluate(denied, crypto.randomUUID()),
    undefined,
    "Job identity must match ledger URL",
  );
  await ledger.goto(`chrome-extension://${installedId}/ledger.html?unauthorized#${jobId}`);
  assert.equal(
    await ledger.evaluate(denied, jobId),
    undefined,
    "Different page URL must be rejected",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    externalRequests,
    [],
    "Store pages must load without external assets or network requests",
  );
  console.log(
    `PASS: ZIP independently unzipped (${names.length} entries); real Chromium boots worker, popup, ledger, and sized icons; configured single origin; only tabs/debugger; exact ledger sender authorization; no external assets`,
  );
} finally {
  await context?.close();
  await rm(scratch, { recursive: true, force: true });
}
