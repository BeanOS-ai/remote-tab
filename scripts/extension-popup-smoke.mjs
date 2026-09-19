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
      activeTab: { id: 17, url: "https://example.test/form", title: "Consented tab" },
    };
    document.addEventListener("invalid", () => globalThis.popupTest.invalidEvents++, true);
    // Headless shell does not supply the chrome namespace on ordinary pages.
    globalThis.chrome ??= {};
    Object.assign(globalThis.chrome, {
      tabs: {
        query: async () => [globalThis.popupTest.activeTab],
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
          if (message.action === "focus-shared")
            test.activeTab = { id: test.state.tabId, url: test.state.url, title: test.state.title };
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
  page.on("pageerror", (error) => {
    failures.push(error.message);
    console.error("Popup page error:", error.message);
  });
  await page.goto("https://popup.test/popup.html");
  await page.waitForFunction(() => globalThis.popupTest.polls >= 2);
  console.log("Popup fixture loaded and state polling verified");
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
  assert.equal(await page.title(), "Remote Tab");
  assert.equal(await page.locator("h1").textContent(), "Remote Tab");
  assert.equal(await page.locator("footer > span").textContent(), "by BeanOS.ai");
  assert.equal(await page.locator("#share-label").textContent(), "Read my tab");
  for (const mode of ["act", "full", "read"]) {
    await page.locator(`input[name=mode][value=${mode}]`).check();
    assert.equal(
      await page.locator("#share-label").textContent(),
      mode === "read" ? "Read my tab" : "Control my tab",
    );
  }
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
    tabId: 17,
    windowId: 1,
    tabMissing: false,
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
  assert.equal(
    await page.locator("#state").textContent(),
    "Agent can click and type · example.test only",
  );
  assert.equal(await page.locator("#tab-label").textContent(), "SHARED TAB");
  assert.equal(await page.locator("#tab").textContent(), "Shared tab\nhttps://example.test");
  assert.equal(await page.locator("#focus-shared").isVisible(), false);
  assert.equal(await page.locator("#shared-tab-status").isVisible(), false);
  assert.equal(await page.locator("#open-ledger").textContent(), "View interaction summary");
  await page.evaluate(() => {
    document.getElementById("error").textContent = "";
  });
  if (screenshotDir)
    await page.locator("body").screenshot({ path: `${screenshotDir}/sharing.png` });
  await page.evaluate(() => {
    globalThis.popupTest.activeTab = {
      id: 29,
      url: "https://elsewhere.test/",
      title: "Another tab",
    };
  });
  await page.locator("#focus-shared").waitFor({ state: "visible" });
  assert.equal(await page.locator("#focus-shared").textContent(), "Go to shared tab");
  assert.equal(await page.locator("#tab").textContent(), "Shared tab\nhttps://example.test");
  assert.equal(
    await page.locator("#shared-tab-status").textContent(),
    "You’re viewing a different tab.",
  );
  if (screenshotDir)
    await page.locator("body").screenshot({ path: `${screenshotDir}/other-tab.png` });
  await page.locator("#focus-shared").click();
  await page.locator("#focus-shared").waitFor({ state: "hidden" });
  assert.deepEqual(
    await page.evaluate(() => globalThis.popupTest.requests.at(-1)),
    { action: "focus-shared" },
    "The worker chooses the consented target; the popup sends no tab or window override",
  );
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
  assert.equal(await page.locator("#tab").textContent(), `${malicious}\nhttps://example.test`);
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
  await page.evaluate((state) => {
    globalThis.popupTest.state = {
      ...state,
      tabMissing: true,
      paused: true,
      handoff: { id: "handoff", message: "Help requested" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    globalThis.popupTest.activeTab = {
      id: 29,
      title: "Another tab",
      url: "https://elsewhere.test/",
    };
  }, live);
  await page.waitForFunction(
    () => document.getElementById("share-status").textContent === "Shared tab closed",
  );
  assert.equal(
    await page.locator("#shared-tab-status").textContent(),
    "The shared tab is closed. Use Stop to end this share.",
  );
  for (const id of ["focus-shared", "pause", "resume", "done", "extend"])
    assert.equal(await page.locator(`#${id}`).isVisible(), false);
  assert.equal(await page.locator("#stop").isEnabled(), true);
  assert.equal(await page.locator("#state").textContent(), "No agent access: shared tab closed.");
  assert.equal(await page.locator("#expiry").isVisible(), false);
  if (screenshotDir)
    await page.locator("body").screenshot({ path: `${screenshotDir}/closed-tab.png` });
  await page.locator("#stop").click();
  await page.locator("#consent").waitFor({ state: "visible" });
  assert.equal(await page.locator("#tab-label").textContent(), "THIS TAB");
  assert.equal(await page.locator("#tab").textContent(), "Another tab\nhttps://elsewhere.test/");
  assert.equal(await page.locator("#shared-tab-status").isVisible(), false);
  assert.equal(await page.locator("#focus-shared").isVisible(), false);
  assert.deepEqual(failures, []);
  console.log(
    "PASS: 372px popup loads bundled Bean Creature; validation is submit-only; Stop works during startup; Pause/Resume and handoff Done are exclusive; Extend is near-expiry and once-only; untrusted data renders as text; interaction summary wording and same/other/closed shared-tab states work",
  );
} finally {
  await browser.close();
}
