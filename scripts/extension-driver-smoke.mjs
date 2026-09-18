// Real Chrome command validation without HTTP sockets. The full installed-extension
// transport/consent smoke remains scripts/extension-smoke.mjs.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/extension-driver-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension } from "../packages/extension/build.ts";
import { TabDriver } from "../packages/extension/src/driver.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const temporary = await mkdtemp(join(tmpdir(), "remote-tab-driver-"));
const url = "http://fixture.test/form";
const html = `<!doctype html><title>Real Chrome driver fixture</title>
<label>Name <input id="name"></label>
<label>Colour <select id="colour"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<button id="submit">Submit</button><p role="status" id="result"></p>
<script>document.querySelector('#submit').onclick=()=>{document.querySelector('#result').textContent='Submitted: '+document.querySelector('#name').value+' / '+document.querySelector('#colour').value;};</script>`;
let context;
try {
  const extension = await buildExtension(
    "https://remote-tab.example",
    join(temporary, "extension"),
  );
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    headless: true,
    channel: "chromium",
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  assert.match(worker.url(), /^chrome-extension:\/\/.+\/worker\.js$/);
  await context.route("http://fixture.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  const calls = [];
  const send = (method, params) => {
    calls.push({ method, params });
    return cdp.send(method, params);
  };
  const options = { mode: "act", scope: "fixture.test", url, title: "Real Chrome driver fixture" };
  const driver = new TabDriver(send, options);
  const eventErrors = [];
  for (const name of [
    "Fetch.requestPaused",
    "Page.frameNavigated",
    "Page.lifecycleEvent",
    "DOM.documentUpdated",
    "Runtime.executionContextsCleared",
  ])
    cdp.on(name, (params) => {
      void driver.onEvent(name, params).catch((error) => eventErrors.push(error));
    });
  await driver.initialize();
  const snapshot = await driver.execute("browser_snapshot");
  const ref = (role) => {
    const value = snapshot.result.text.match(new RegExp(`${role}[^\\n]*\\[ref=(e\\d+)\\]`))?.[1];
    assert.ok(value, `Accessibility snapshot must expose ${role}`);
    return value;
  };
  const input = ref("textbox");
  const select = ref("combobox");
  const button = ref("button");
  const screenshots = [];
  for (const [tool, args] of [
    ["browser_type", { ref: input, text: "Grace" }],
    ["browser_select_option", { ref: select, values: ["blue"] }],
    ["browser_click", { ref: button }],
  ]) {
    const result = await driver.execute(tool, args);
    assert.ok(result.screenshot.byteLength > 100, `${tool} must capture the real viewport`);
    assert.deepEqual([...result.screenshot.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    screenshots.push(result.screenshot);
  }
  assert.equal(await page.locator("#name").inputValue(), "Grace");
  assert.equal(await page.locator("#colour").inputValue(), "blue");
  assert.equal(await page.locator("#result").textContent(), "Submitted: Grace / blue");
  assert.notDeepEqual(screenshots[0], screenshots[2], "Screenshot must reflect the changed page");
  const after = await driver.execute("browser_snapshot");
  assert.match(after.result.text, /Submitted: Grace \/ blue/);
  assert.ok(
    after.result.text.includes(`[ref=${button}]`),
    "Refs remain stable in the same document",
  );
  let before = calls.length;
  await assert.rejects(driver.execute("browser_evaluate", { function: "() => 42" }), {
    code: "mode_denied",
  });
  await assert.rejects(driver.execute("browser_navigate", { url: "https://outside.test/" }), {
    code: "scope_denied",
  });
  assert.equal(calls.length, before, "Denied operations must not reach CDP");
  const read = new TabDriver(send, { ...options, mode: "read" });
  before = calls.length;
  await assert.rejects(read.execute("browser_click", { ref: button }), { code: "mode_denied" });
  await assert.rejects(read.execute("browser_type", { ref: input, text: "Denied" }), {
    code: "mode_denied",
  });
  assert.equal(calls.length, before);
  const full = new TabDriver(send, { ...options, mode: "full" });
  const evaluated = await full.execute("browser_evaluate", {
    function: "() => document.querySelector('#name').value",
  });
  assert.equal(evaluated.result, "Grace");
  assert.ok(evaluated.screenshot.byteLength > 100);
  // Inspect real input state after each CDP key event: key names alone do not
  // cause Chromium to insert printable characters without the correct text.
  await driver.execute("browser_type", { ref: input, text: "" });
  for (const [key, expected] of [
    ["a", "a"],
    ["Space", "a "],
    ["b", "a b"],
    ["Shift+c", "a bC"],
    ["Shift+1", "a bC!"],
    ["Shift+;", "a bC!:"],
    ["Shift+'", 'a bC!:"'],
  ]) {
    await driver.execute("browser_press_key", { key });
    assert.equal(
      await page.locator("#name").inputValue(),
      expected,
      `${key} must insert its printable character`,
    );
  }
  await driver.execute("browser_press_key", { key: "Control+a" });
  assert.equal(
    await page.locator("#name").inputValue(),
    'a bC!:"',
    "Control shortcut must not insert text",
  );
  assert.deepEqual(
    await page
      .locator("#name")
      .evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [0, 7],
    "Control+A must select all input text",
  );
  await driver.execute("browser_press_key", { key: "z" });
  assert.equal(
    await page.locator("#name").inputValue(),
    "z",
    "Typing replaces the shortcut selection",
  );
  assert.deepEqual(eventErrors, []);
  await cdp.detach();
  console.log(
    "PASS: real Chromium driver AX refs, type, select, click, live PNGs, stable refs, printable keys and Control shortcut, read/act/full modes and site denial; installed extension worker loaded",
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
