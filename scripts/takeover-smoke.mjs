// Optional real-Chromium event-ordering test; no fixture server or external network.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/takeover-smoke.mjs
import assert from "node:assert/strict";
import { TabDriver } from "../packages/extension/src/driver.ts";
import { TakeoverMonitor } from "../packages/extension/src/takeover.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Takeover fixture</title>
      <style>body{padding:30px}input,button{margin:20px;width:180px;height:40px}</style>
      <label>Name <input id=name aria-label=Name></label><button id=submit>Submit</button>
      <p id=result role=status></p>
      <script>submit.onclick=()=>result.textContent='Clicked';</script>`,
    }),
  );
  const page = await context.newPage();
  await page.goto("https://takeover.test/");
  const cdp = await context.newCDPSession(page);
  let pauses = 0;
  const errors = [];
  const trace = [];
  const monitor = new TakeoverMonitor(
    async (method, params, sessionId) => {
      assert.equal(sessionId, undefined, "Main-frame smoke should not create child targets");
      if (method.startsWith("Input.")) trace.push({ method, params });
      const result = await cdp.send(method, params);
      if (method.startsWith("Input.")) trace.push({ response: method });
      return result;
    },
    () => {
      pauses++;
      trace.push({ paused: true });
    },
  );
  const driver = new TabDriver((method, params) => monitor.dispatch(method, params), {
    mode: "act",
    scope: "takeover.test",
    url: page.url(),
    title: "Takeover fixture",
  });
  for (const method of [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Page.lifecycleEvent",
    "Page.frameNavigated",
    "Fetch.requestPaused",
  ]) {
    cdp.on(method, (params) => {
      if (method === "Runtime.bindingCalled") trace.push({ input: JSON.parse(params.payload) });
      void monitor.onEvent(method, params).catch((error) => errors.push(error));
      void driver.onEvent(method, params).catch((error) => errors.push(error));
    });
  }
  await monitor.initialize();
  await driver.initialize();
  const snapshot = await driver.execute("browser_snapshot");
  const input = snapshot.result.text.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1];
  const button = snapshot.result.text.match(/button[^\n]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(input);
  assert.ok(button);
  for (const [tool, args] of [
    ["browser_hover", { ref: button }],
    ["browser_click", { ref: button }],
    ["browser_click", { ref: input }],
    ["browser_press_key", { key: "a" }],
    ["browser_press_key", { key: "Shift+b" }],
    ["browser_press_key", { key: "ArrowLeft" }],
    ["browser_drag", { startRef: input, endRef: button }],
  ]) {
    await driver.execute(tool, args);
    // A protocol round trip also drains binding events queued around the dispatch response.
    await cdp.send("Runtime.evaluate", { expression: "0" });
    if (pauses) console.error(JSON.stringify(trace, null, 2));
    assert.equal(pauses, 0, `${tool} must not be mistaken for human takeover`);
    assert.deepEqual(errors, []);
  }
  assert.equal(await page.locator("#result").textContent(), "Clicked");
  assert.equal(await page.locator("#name").inputValue(), "aB");
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
    window.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 14, clientY: 23, bubbles: true }),
    );
  });
  assert.equal(pauses, 0, "Synthetic page events must not pause");
  await page.keyboard.press("z");
  await cdp.send("Runtime.evaluate", { expression: "0" });
  assert.ok(pauses > 0, "External trusted keyboard input must pause");
  const afterKeyboard = pauses;
  await page.mouse.click(20, 20);
  await cdp.send("Runtime.evaluate", { expression: "0" });
  assert.ok(pauses > afterKeyboard, "External trusted mouse input must pause");
  assert.deepEqual(errors, []);
  await monitor.dispose();
  await cdp.detach();
  console.log(
    "PASS: real Chromium wrapped hover/click/key/drag do not pause; external trusted keyboard/mouse pause; synthetic page events ignored. Automation timestamps are about 1 second ahead to distinguish delayed own events.",
  );
} finally {
  await browser.close();
}
