// Explicit real-Chromium runner. Uses production driver/privacy with local fixtures;
// injected CDP inspection failures exercise the boundary without a relay server.
import assert from "node:assert/strict";
import { TabDriver } from "../../packages/extension/src/driver.ts";
import { PrivacyGuard } from "../../packages/extension/src/privacy.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  ...(proxyServer
    ? {
        proxy: {
          server: proxyServer,
          ...(process.env.NO_PROXY ? { bypass: process.env.NO_PROXY } : {}),
        },
      }
    : {}),
});
try {
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "https://navigation.test") return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Navigation test</title><p>Public content</p>
        <iframe id="advert" style="position:absolute;left:20px;top:100px;width:300px;height:100px" srcdoc="Advertisement fixture"></iframe>`,
    });
  });
  const page = await context.newPage();
  await page.goto("https://navigation.test/start");
  const session = await context.newCDPSession(page);
  let failInspection = false;
  let failAfterNavigation = false;
  let moveFrameDuringCapture = false;
  let navigationCalls = 0;
  let screenshotCalls = 0;
  const failures = [];
  const send = async (method, params) => {
    if (method === "DOMSnapshot.captureSnapshot" && failInspection)
      throw new Error("PRIVATE-RAW-CDP-DETAIL");
    const result = await session.send(method, params);
    if (method === "Page.navigate" || method === "Page.navigateToHistoryEntry") {
      navigationCalls++;
      if (failAfterNavigation) failInspection = true;
    }
    if (method === "Page.captureScreenshot") {
      screenshotCalls++;
      if (moveFrameDuringCapture)
        await page.evaluate(() => {
          document.querySelector("#advert").style.left = "80px";
        });
    }
    return result;
  };
  const driver = new TabDriver(send, {
    mode: "full",
    scope: null,
    url: page.url(),
    title: "Navigation test",
    privacy: new PrivacyGuard(send),
  });
  for (const event of [
    "Fetch.requestPaused",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.lifecycleEvent",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "DOM.documentUpdated",
    "Runtime.executionContextsCleared",
  ])
    session.on(event, (params) => {
      void driver.onEvent(event, params).catch((error) => failures.push(error));
    });
  await driver.initialize();

  failInspection = true;
  for (const tool of ["browser_navigate", "browser_navigate_back"]) {
    await assert.rejects(driver.execute(tool, { url: "https://navigation.test/next" }), {
      code: "privacy_denied",
    });
    assert.equal(page.url(), "https://navigation.test/start");
    assert.equal(navigationCalls, 0);
    assert.equal(screenshotCalls, 0);
  }

  failInspection = false;
  failAfterNavigation = true;
  const expectedUnavailable = {
    result: {
      ok: true,
      navigated: true,
      content_unavailable: "privacy",
      reason: "inspection_failed",
      message: "The browser could not provide a privacy inspection snapshot",
    },
  };
  const forward = await driver.execute("browser_navigate", { url: "https://navigation.test/next" });
  assert.equal(page.url(), "https://navigation.test/next");
  assert.deepEqual(forward, expectedUnavailable);
  assert.ok(!JSON.stringify(forward).includes("PRIVATE-RAW"));
  assert.equal(screenshotCalls, 0);
  failInspection = false;
  const back = await driver.execute("browser_navigate_back");
  assert.equal(page.url(), "https://navigation.test/start");
  assert.deepEqual(back, expectedUnavailable);
  assert.equal(screenshotCalls, 0);

  // A moving advertising frame reproduces one concrete capture failure without
  // changing any privacy limits. This is not evidence of CNN's original cause.
  failInspection = false;
  failAfterNavigation = false;
  moveFrameDuringCapture = true;
  const movingFrame = await driver.execute("browser_navigate", {
    url: "https://navigation.test/dynamic",
  });
  assert.equal(page.url(), "https://navigation.test/dynamic");
  assert.deepEqual(movingFrame, {
    result: {
      ok: true,
      navigated: true,
      content_unavailable: "privacy",
      reason: "masks_changed",
      message: "Protected field or embedded-frame geometry changed during screenshot capture",
    },
  });
  assert.equal(screenshotCalls, 1);
  // Inspection can recover immediately, as in #32, while unsafe pixels remain withheld.
  assert.equal((await driver.execute("browser_snapshot")).result.url, page.url());
  assert.equal(screenshotCalls, 1);
  assert.deepEqual(failures, []);
  console.log(
    "PASS: real Chromium navigation privacy refusal preserves actual URL; committed forward/back navigation succeeds without content; moving iframe yields masks_changed and withholds captured pixels",
  );
} finally {
  await browser.close();
}
