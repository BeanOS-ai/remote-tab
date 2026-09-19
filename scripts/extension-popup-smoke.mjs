// Real Chromium popup rendering with a fake Chrome state provider and routed assets.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/extension-popup-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomSecret } from "../packages/protocol/src/crypto.ts";
import { formatCode } from "../packages/protocol/src/index.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const screenshotDir = process.env.POPUP_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const bundle = await Bun.build({
  entrypoints: ["packages/extension/src/popup.ts"],
  target: "browser",
  format: "esm",
  minify: true,
});
assert.equal(bundle.success, true);
const assets = new Map([
  ["/popup.html", ["text/html", await Bun.file("packages/extension/popup.html").text()]],
  ["/popup.js", ["text/javascript", await bundle.outputs[0].text()]],
  ["/style.css", ["text/css", await Bun.file("packages/extension/style.css").text()]],
  [
    "/bean-creature.svg",
    ["image/svg+xml", await Bun.file("packages/extension/bean-creature.svg").text()],
  ],
]);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await context.route("**/*", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: asset ? 200 : 404,
      contentType: asset?.[0],
      body: asset?.[1] ?? "",
    });
  });
  await context.addInitScript(() => {
    globalThis.popupTest = {
      state: { sharing: false },
      polls: 0,
      requests: [],
      resolveShare: undefined,
      invalidEvents: 0,
    };
    document.addEventListener("invalid", () => globalThis.popupTest.invalidEvents++, true);
    Object.assign(globalThis.chrome, {
      tabs: {
        query: async () => [{ id: 17, url: "https://example.test/form", title: "Consented tab" }],
      },
      runtime: {
        sendMessage: async (message) => {
          const test = globalThis.popupTest;
          if (message.action === "state") {
            test.polls++;
            return structuredClone(test.state);
          }
          test.requests.push(message);
          if (message.action === "share") {
            test.state = { sharing: false, starting: true };
            return new Promise((resolve) => {
              test.resolveShare = resolve;
            });
          }
          if (message.action === "stop") {
            test.state = { sharing: false };
            test.resolveShare?.({ ok: false, error: "Sharing cancelled" });
          }
          if (message.action === "pause") test.state.paused = true;
          if (message.action === "resume") test.state.paused = false;
          if (message.action === "done") {
            test.state.paused = false;
            test.state.handoff = undefined;
          }
          if (message.action === "extend") {
            test.state.extended = true;
            test.state.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
          }
          return { ok: true };
        },
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("https://popup.test/popup.html");
  await page.waitForFunction(() => globalThis.popupTest.polls >= 2);
  assert.equal(
    await page.locator("body").evaluate((body) => body.getBoundingClientRect().width),
    372,
  );
  assert.equal(
    await page
      .locator('img[src="bean-creature.svg"]')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  assert.equal(await page.locator('a[href="https://beanos.ai/remote-tab"]').count(), 1);
  assert.equal(await page.locator("details").getAttribute("open"), null);
  if (screenshotDir)
    await page.locator("body").screenshot({ path: `${screenshotDir}/consent.png` });
  assert.equal(await page.locator("#error").textContent(), "");
  assert.equal(await page.evaluate(() => globalThis.popupTest.invalidEvents), 0);
  await page.locator("#share").click();
  assert.equal(
    await page.locator("#error").textContent(),
    "Paste a valid rt1. code from your agent",
  );
  assert.equal(await page.evaluate(() => globalThis.popupTest.invalidEvents), 0);
  assert.equal(await page.evaluate(() => globalThis.popupTest.requests.length), 0);
  await page.locator("#code").fill("rt1.invalid");
  await page.locator("#share").click();
  const message = "Paste a valid rt1. code from your agent";
  assert.equal(await page.locator("#error").textContent(), message);
  const polls = await page.evaluate(() => globalThis.popupTest.polls);
  await page
    .waitForFunction((before) => globalThis.popupTest.polls >= before + 2, polls)
    .catch(async (error) => {
      console.error({
        before: polls,
        current: await page.evaluate(() => globalThis.popupTest.polls),
        failures,
      });
      throw error;
    });
  assert.equal(
    await page.locator("#error").textContent(),
    message,
    "Polling must preserve local validation errors",
  );
  assert.equal(await page.evaluate(() => globalThis.popupTest.requests.length), 0);
  console.log("Popup malformed-code polling verified");

  await page.locator("#code").fill(formatCode(randomSecret()));
  await page.locator("#share").click();
  await page.waitForFunction(() => globalThis.popupTest.state.starting === true);
  console.log("Popup starting state reached");
  assert.equal(await page.locator("#stop").isVisible(), true);
  assert.equal(await page.locator("#stop").isEnabled(), true);
  await page.locator("#stop").click();
  await page.waitForFunction(
    () => globalThis.popupTest.state.sharing === false && !globalThis.popupTest.state.starting,
  );
  assert.equal(await page.locator("#stop").isDisabled(), true);
  console.log("Popup startup Stop verified");

  const live = {
    sharing: true,
    mode: "act",
    scope: "example.test",
    paused: false,
    sessionId: "fixture-session",
    title: "Shared tab",
    url: "https://example.test/form",
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    actions: [],
  };
  await page.evaluate((state) => {
    globalThis.popupTest.state = state;
  }, live);
  await page.locator("#pause").waitFor({ state: "visible" });
  assert.equal(await page.locator("#share-status").textContent(), "Sharing");
  await page.evaluate(() => {
    document.getElementById("error").textContent = "";
  });
  if (screenshotDir)
    await page.locator("body").screenshot({ path: `${screenshotDir}/sharing.png` });
  await page.locator("#pause").click();
  await page.locator("#resume").waitFor({ state: "visible" });
  assert.equal(await page.locator("#share-status").textContent(), "Paused");
  assert.equal(await page.locator("#pause").isVisible(), false);
  if (screenshotDir) await page.locator("body").screenshot({ path: `${screenshotDir}/paused.png` });
  assert.equal(await page.locator("#done").isVisible(), false);
  assert.equal(await page.locator("#extend").isVisible(), false);
  await page.locator("#resume").click();
  await page.locator("#resume").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#pause").isVisible(), true);
  assert.equal(await page.locator("#share-status").textContent(), "Sharing");

  const malicious =
    '<img id="injected-image" src="bad" onerror="globalThis.injected=true"><script>globalThis.injected=true</script>';
  await page.evaluate(
    ({ state, text }) => {
      globalThis.popupTest.state = {
        ...state,
        paused: true,
        title: text,
        actions: [text],
        handoff: { id: "handoff", message: text },
        expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      };
    },
    { state: live, text: malicious },
  );
  await page.locator("#done").waitFor({ state: "visible" });
  assert.equal(await page.locator("#pause").isVisible(), false);
  assert.equal(await page.locator("#resume").isVisible(), false);
  assert.equal(await page.locator("#extend").isVisible(), true);
  assert.equal(await page.locator("#handoff-message").textContent(), malicious);
  assert.equal(await page.locator("#feed li").textContent(), malicious);
  assert.equal(await page.locator("#tab").textContent(), `${malicious}\n${live.url}`);
  assert.equal(await page.locator("#injected-image").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.injected === true), false);
  await page.locator("#done").click();
  await page.locator("#done").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#resume").isVisible(), false);
  await page.locator("#extend").click();
  await page.locator("#extend").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    globalThis.popupTest.state.expiresAt = new Date(Date.now() + 60_000).toISOString();
  });
  const before = await page.evaluate(() => globalThis.popupTest.polls);
  await page.waitForFunction((polls) => globalThis.popupTest.polls > polls, before);
  assert.equal(
    await page.locator("#extend").isVisible(),
    false,
    "Already-extended sessions cannot extend again",
  );
  assert.deepEqual(failures, []);
  console.log(
    "PASS: 372px popup loads bundled Bean Creature; empty/malformed-code validation is submit-only; Stop works during startup; explicit Pause/Resume and handoff Done are exclusive; Extend is near-expiry and once-only; untrusted title/actions/handoff render as text",
  );
} finally {
  await browser.close();
}
