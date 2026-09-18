// Real Chromium ledger UI, real encrypted session history, and the production chunk transport.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/ledger-page-smoke.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { BrowserPeer, createSession } from "../packages/client/src/index.ts";
import { buildExtension } from "../packages/extension/build.ts";
import { LedgerJobs } from "../packages/extension/src/ledger-data.ts";
import { MemoryStore, createApp } from "../packages/server/src/index.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({
  entrypoints: ["packages/extension/src/ledger.ts"],
  target: "browser",
  format: "esm",
  minify: true,
});
assert.equal(bundle.success, true, JSON.stringify(bundle.logs));
const assets = new Map([
  ["/ledger.html", ["text/html", await Bun.file("packages/extension/ledger.html").text()]],
  ["/ledger.js", ["text/javascript", await bundle.outputs[0].text()]],
  ["/ledger.css", ["text/css", await Bun.file("packages/extension/ledger.css").text()]],
]);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
const jobs = new LedgerJobs();
const jobIds = [];
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route("**/*", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: asset ? 200 : 404,
      contentType: asset?.[0],
      body: asset?.[1] ?? "",
    });
  });
  const fixture = await context.newPage();
  const frames = [];
  await fixture.setViewportSize({ width: 80, height: 40 });
  for (const color of ["red", "blue"]) {
    await fixture.setContent(`<html style="background:${color}"></html>`);
    frames.push(new Uint8Array(await fixture.screenshot({ type: "png" })));
  }
  await fixture.close();
  const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["smoke", "smoke-key"]]) });
  const options = {
    serverUrl: "http://remote-tab.test",
    fetch: (request) => app.fetch(request),
    timeoutMs: 5000,
    pollWaitSeconds: 0,
    pollIntervalMs: 1,
  };
  const { code, session } = await createSession({ ...options, apiKey: "smoke-key" });
  const malicious =
    '<img id="injected-image" src="bad" onerror="globalThis.injected=true"><script>globalThis.injected=true</script>';
  const peer = await BrowserPeer.redeem({
    ...options,
    code,
    hello: {
      mode: "act",
      scope: "example.test",
      url: "https://example.test/",
      title: malicious,
      extension_version: "2.0.0",
    },
  });
  for (const bytes of frames) {
    const pending = session.send("browser_click", { ref: "e1" });
    const command = await peer.nextCommand();
    await peer.sendResult(
      command.id,
      { text: malicious },
      { screenshot: { bytes, mimeType: "image/png" } },
    );
    await pending;
  }
  const failed = session
    .send("browser_type", { ref: "e1", text: "do-not-echo-input" })
    .catch(() => undefined);
  const command = await peer.nextCommand();
  await peer.sendError(command.id, "paused", malicious);
  await failed;
  const active = await peer.ledger();
  const unfinished = session
    .send("browser_navigate", { url: "https://example.test/" })
    .catch(() => undefined);
  await peer.nextCommand();
  await peer.stop();
  await unfinished;
  const history = await peer.ledger();
  assert.equal(history.status.state, "stopped");
  const createJob = (ledger) => {
    const id = jobs.create({ sessionId: ledger.sessionId, ledger: async () => ledger });
    jobIds.push(id);
    return id;
  };
  let loading = true;
  const requests = [];
  await context.exposeBinding("ledgerRpc", (_source, message, corrupt) => {
    requests.push(message);
    if (message.action === "ledger-status") {
      if (loading) return { state: "loading", sessionId: history.sessionId };
      return jobs.status(message.jobId);
    }
    if (message.action === "ledger-release") {
      jobs.release(message.jobId);
      return { ok: true };
    }
    assert.equal(message.action, "ledger-chunk");
    const chunk = jobs.chunk(
      message.jobId,
      message.kind,
      message.offset,
      message.entry,
      message.attachment,
    );
    return corrupt
      ? { ...chunk, data: `${chunk.data[0] === "A" ? "B" : "A"}${chunk.data.slice(1)}` }
      : chunk;
  });
  await context.addInitScript(() => {
    globalThis.ledgerTest = {
      dead: false,
      corrupt: location.search.includes("corrupt"),
      calls: 0,
      revoked: [],
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      globalThis.ledgerTest.revoked.push(url);
      revoke(url);
    };
    Object.assign(globalThis.chrome, {
      runtime: {
        sendMessage: (message) => {
          const state = globalThis.ledgerTest;
          state.calls++;
          if (state.dead) return Promise.reject(new Error("Worker terminated"));
          return globalThis.ledgerRpc(message, state.corrupt);
        },
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`https://ledger.test/ledger.html#${createJob(history)}`);
  assert.equal(await page.locator("#download-zip").isDisabled(), true);
  assert.equal(await page.locator("#render-gif").isDisabled(), true);
  assert.equal(await page.locator('#status[data-state="verified"]').count(), 0);
  loading = false;
  await page.locator('#status[data-state="verified"]').waitFor();
  assert.match(await page.locator("#status").textContent(), /stopped session history/);
  assert.match(
    await page.locator("#session").textContent(),
    new RegExp(`Last sequence ${history.status.last_seq}`),
  );
  const timeline = await page.locator("#timeline").textContent();
  assert.ok(timeline.includes(malicious));
  assert.ok(timeline.includes("Failed:"));
  assert.ok(timeline.includes("Incomplete — no result recorded."));
  assert.ok(timeline.includes("Clicked an element"));
  assert.ok(timeline.includes("do-not-echo-input"), "Command details retain complete ledger data");
  assert.equal(
    await page.locator("#timeline h3").filter({ hasText: "do-not-echo-input" }).count(),
    0,
  );
  assert.equal(await page.locator("#injected-image, #timeline script").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.injected === true), false);
  assert.equal(await page.locator('#timeline img[src^="blob:"]').count(), 2);
  assert.ok(requests.some((message) => message.action === "ledger-release"));
  const calls = await page.evaluate(() => {
    globalThis.ledgerTest.dead = true;
    return globalThis.ledgerTest.calls;
  });
  const zipEvent = page.waitForEvent("download");
  await page.locator("#download-zip").click();
  const zip = await zipEvent;
  assert.equal(zip.suggestedFilename(), `${history.sessionId}-ledger.zip`);
  const zipBytes = new Uint8Array(await Bun.file(await zip.path()).arrayBuffer());
  assert.deepEqual(Array.from(zipBytes.slice(0, 4)), [80, 75, 3, 4]);
  await page.locator("#render-gif").click();
  await page.waitForFunction(() => {
    const image = document.getElementById("gif-player");
    return image.complete && image.naturalWidth === 640 && image.naturalHeight === 360;
  });
  const firstUrl = await page.locator("#gif-player").getAttribute("src");
  const gifEvent = page.waitForEvent("download");
  await page.locator("#download-gif").click();
  const gif = await gifEvent;
  assert.equal(gif.suggestedFilename(), `${history.sessionId}.gif`);
  const gifBytes = new Uint8Array(await Bun.file(await gif.path()).arrayBuffer());
  assert.equal(new TextDecoder().decode(gifBytes.slice(0, 6)), "GIF89a");
  assert.equal(gifBytes.at(-1), 0x3b);
  await page.locator("#render-gif").click();
  await page.waitForFunction((old) => document.getElementById("gif-player").src !== old, firstUrl);
  assert.equal(
    await page.evaluate((old) => globalThis.ledgerTest.revoked.includes(old), firstUrl),
    true,
  );
  const repeatedGif = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await fetch(document.getElementById("gif-player").src)).arrayBuffer()),
    ),
  );
  assert.deepEqual(
    repeatedGif,
    Array.from(gifBytes),
    "Repeated replay rendering must be deterministic",
  );
  assert.equal(
    await page.evaluate(() => globalThis.ledgerTest.calls),
    calls,
    "Exports must work without the worker",
  );
  await page.screenshot({ path: "/tmp/remote-tab-ledger-smoke.png", fullPage: true });
  const activePage = await context.newPage();
  await activePage.goto(`https://ledger.test/ledger.html#${createJob(active)}`);
  await activePage.locator('#status[data-state="verified"]').waitFor();
  assert.match(await activePage.locator("#status").textContent(), /active-session snapshot/);
  assert.equal(await activePage.locator("#download-zip").isEnabled(), true);
  assert.equal(await activePage.locator("#render-gif").isDisabled(), true);
  assert.match(await activePage.locator("#export-status").textContent(), /Stop sharing/);
  const badPage = await context.newPage();
  await badPage.goto(`https://ledger.test/ledger.html?corrupt#${createJob(history)}`);
  await badPage.locator('#status[data-state="error"]').waitFor();
  assert.equal(await badPage.locator('#status[data-state="verified"]').count(), 0);
  assert.equal(await badPage.locator("#download-zip").isDisabled(), true);
  assert.equal(await badPage.locator("#render-gif").isDisabled(), true);
  const brokenPair = await createSession({ ...options, apiKey: "smoke-key" });
  const brokenPeer = await BrowserPeer.redeem({
    ...options,
    code: brokenPair.code,
    hello: {
      mode: "read",
      scope: "example.test",
      url: "https://example.test/",
      title: "Broken PNG",
      extension_version: "2.0.0",
    },
  });
  const brokenResult = brokenPair.session.send("browser_take_screenshot");
  const brokenCommand = await brokenPeer.nextCommand();
  await brokenPeer.sendResult(
    brokenCommand.id,
    {},
    { screenshot: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" } },
  );
  await brokenResult;
  await brokenPeer.stop();
  const brokenPage = await context.newPage();
  await brokenPage.goto(`https://ledger.test/ledger.html#${createJob(await brokenPeer.ledger())}`);
  await brokenPage.locator('#status[data-state="verified"]').waitFor();
  assert.match(
    await brokenPage.locator("#timeline").textContent(),
    /Screenshot preview unavailable/,
  );
  const brokenZipEvent = brokenPage.waitForEvent("download");
  await brokenPage.locator("#download-zip").click();
  assert.equal((await brokenZipEvent).suggestedFilename(), `${brokenPeer.sessionId}-ledger.zip`);
  await brokenPage.locator("#render-gif").click();
  await brokenPage.waitForFunction(() =>
    document.getElementById("export-status").textContent.includes("not a valid PNG"),
  );
  assert.equal(await brokenPage.locator("#download-zip").isEnabled(), true);
  await page.reload();
  await page.locator('#status[data-state="error"]').waitFor();
  assert.equal(await page.locator("#download-zip").isDisabled(), true);
  assert.deepEqual(failures, []);
  const extensionPath = await buildExtension();
  const extension = await chromium.launchPersistentContext("", {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [
      `--disable-extensions-except=${resolve(extensionPath)}`,
      `--load-extension=${resolve(extensionPath)}`,
    ],
  });
  try {
    const worker = extension.serviceWorkers()[0] ?? (await extension.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const missingId = crypto.randomUUID();
    const installedPage = await extension.newPage();
    await installedPage.goto(`chrome-extension://${extensionId}/ledger.html#${missingId}`);
    await installedPage.locator('#status[data-state="error"]').waitFor();
    const response = await installedPage.evaluate(
      (jobId) => chrome.runtime.sendMessage({ action: "ledger-status", jobId }),
      missingId,
    );
    assert.equal(
      response.code,
      "ledger_unavailable",
      "Chrome must preserve the sender URL fragment for an authorized viewer",
    );
    const wrongJob = await installedPage.evaluate(async (jobId) => {
      try {
        return await chrome.runtime.sendMessage({ action: "ledger-status", jobId });
      } catch {
        return undefined;
      }
    }, crypto.randomUUID());
    assert.equal(wrongJob, undefined, "A ledger page must not read another job");
    await installedPage.goto(
      `chrome-extension://${extensionId}/ledger.html?unauthorized#${missingId}`,
    );
    const wrongUrl = await installedPage.evaluate(async (jobId) => {
      try {
        return await chrome.runtime.sendMessage({ action: "ledger-status", jobId });
      } catch {
        return undefined;
      }
    }, missingId);
    assert.equal(wrongUrl, undefined, "A different extension URL must be rejected");
  } finally {
    await extension.close();
  }
  console.log(
    "PASS: real encrypted ledger and PNG bytes; verified timeline and incomplete/error results; literal hostile text; ZIP and deterministic playable GIF downloads; blob cleanup; worker-independent exports; active replay disabled; malformed PNG still exports ZIP; corrupt transfer and reload fail closed; installed Chrome sender fragment and job authorization",
  );
} finally {
  for (const id of jobIds) jobs.release(id);
  await browser.close();
}
