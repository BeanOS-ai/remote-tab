// Optional real-Chromium test. Run with Bun after installing Playwright separately:
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/extension-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../packages/client/src/index.ts";
import { buildExtension } from "../packages/extension/build.ts";
import { createApp } from "../packages/server/src/app.ts";
import { MemoryStore } from "../packages/server/src/memory-store.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const temporary = await mkdtemp(join(tmpdir(), "remote-tab-extension-"));
const app = createApp({ store: new MemoryStore(), apiKeys: new Map([["smoke", "test-key"]]) });
const http = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/form"
      ? new Response(
          `<!doctype html><title>Extension smoke form</title>
      <label>Name <input id="name"></label><button id="submit">Submit</button><p role="status" id="result"></p>
      <script>document.querySelector('#submit').onclick = () => { document.querySelector('#result').textContent = 'Submitted: ' + document.querySelector('#name').value; };</script>`,
          { headers: { "content-type": "text/html" } },
        )
      : app.fetch(request),
});
let context;
try {
  const origin = http.url.origin;
  assert.equal((await fetch(`${origin}/form`, { signal: AbortSignal.timeout(5000) })).status, 200);
  console.log("Local HTTP fixture verified");
  const extension = await buildExtension(origin, join(temporary, "extension"));
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    headless: true,
    channel: "chromium",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  console.log("Chromium launched");
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  console.log("Extension worker loaded");
  const extensionId = new URL(worker.url()).host;
  const tab = await context.newPage();
  await tab.goto(`${origin}/form`);
  // Open consent as an inactive extension page so its active-tab capture matches
  // the toolbar popup rather than capturing the extension page itself.
  await tab.bringToFront();
  const popupReady = context.waitForEvent("page");
  await worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `chrome-extension://${extensionId}/popup.html`,
  );
  const popup = await popupReady;
  await popup.waitForLoadState();
  const { code, session } = await createSession({
    serverUrl: origin,
    apiKey: "test-key",
    timeoutMs: 10000,
    pollWaitSeconds: 0,
    pollIntervalMs: 10,
  });
  await popup.locator("#code").fill(code);
  await popup.locator('input[value="act"]').check();
  // Match the toolbar popup: the consented website remains the active tab.
  await tab.bringToFront();
  await popup.locator("#consent").evaluate((form) => form.requestSubmit());
  console.log("Consent submitted");
  const hello = await session.waitReady();
  assert.equal(hello.mode, "act");
  assert.equal(hello.url, `${origin}/form`);
  assert.equal(hello.scope, "127.0.0.1");
  console.log("Authenticated hello received");
  const snapshot = await session.send("browser_snapshot");
  assert.equal(snapshot.ok, true);
  const input = snapshot.result.text.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1];
  const button = snapshot.result.text.match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(input, "Live accessibility tree must expose the Name input ref");
  assert.ok(button, "Live accessibility tree must expose the Submit button ref");
  for (const result of [
    await session.send("browser_type", { ref: input, text: "Grace" }),
    await session.send("browser_click", { ref: button }),
  ]) {
    assert.equal(result.ok, true);
    assert.equal(result.screenshot.mime_type, "image/png");
    assert.ok(result.attachments[0].bytes.byteLength > 100);
    assert.deepEqual(
      [...new Uint8Array(result.attachments[0].bytes).slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  }
  assert.equal(await tab.locator("#result").textContent(), "Submitted: Grace");
  const denied = await session.send("browser_evaluate", { function: "() => 42" });
  assert.equal(denied.error.code, "mode_denied");
  const ledger = await session.ledger();
  assert.equal(ledger.entries.filter((entry) => entry.attachments.length).length, 2);
  await popup.locator("#stop").evaluate((button) => button.click());
  await popup.waitForFunction(() => !document.querySelector("#consent").hidden);
  assert.equal((await session.status()).state, "stopped");
  await assert.rejects(session.send("browser_click", { ref: button }), {
    code: "session_not_active",
  });
  console.log(
    "PASS: installed extension consent, hello, AX refs, live type/click, encrypted PNGs, mode denial, ledger and Stop",
  );
} finally {
  await context?.close();
  await http.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
