// Optional real-Chromium pixel test. Run with Bun and a separate Playwright install:
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/privacy-smoke.mjs
import assert from "node:assert/strict";
import { TabDriver } from "../packages/extension/src/driver.ts";
import { PrivacyGuard } from "../packages/extension/src/privacy.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
  });
  await context.route("https://privacy.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>body{margin:0;height:1800px}input,iframe,#shadow{position:absolute;width:180px;height:50px;border:0;padding:0}#password{top:40px;left:20px;background:red}#otp{top:120px;left:20px;background:green}#shadow{top:200px;left:20px}iframe{top:280px;left:20px}#safe{position:absolute;top:40px;left:300px;width:150px;height:50px;background:yellow}</style><input id=password type=password value="fake-password-1"><input id=otp autocomplete="section-login one-time-code" value="123456"><div id=shadow></div><iframe src="https://frame.test/"></iframe><div id=safe>Ordinary content</div><script>const root=document.querySelector('#shadow').attachShadow({mode:'closed'});root.innerHTML='<input type=password value="closed-secret" style="width:180px;height:50px;border:0;padding:0;background:blue">';</script>`,
    }),
  );
  await context.route("https://frame.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<body style='margin:0;background:purple'><input autocomplete=cc-number value=4111111111111111>",
    }),
  );
  const page = await context.newPage();
  await page.goto("https://privacy.test/");
  const cdp = await context.newCDPSession(page);
  const canvasPage = await context.newPage();
  const bundle = await Bun.build({
    entrypoints: ["packages/extension/src/privacy.ts"],
    target: "browser",
    format: "esm",
  });
  assert.equal(bundle.success, true);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(await bundle.outputs[0].text()).toString("base64")}`;
  await canvasPage.evaluate(async (url) => {
    globalThis.privacyModule = await import(url);
  }, moduleUrl);
  const privacy = new PrivacyGuard((method, params) => cdp.send(method, params), {
    maskImage: async (bytes, clip, masks) =>
      new Uint8Array(
        await canvasPage.evaluate(
          async ({ png, region, rectangles }) =>
            Array.from(
              await globalThis.privacyModule.maskPng(new Uint8Array(png), region, rectangles),
            ),
          { png: Array.from(bytes), region: clip, rectangles: masks },
        ),
      ),
  });
  await privacy.scan();
  assert.equal(
    privacy.sanitize("fake-password-1 closed-secret 123456"),
    "[redacted] [redacted] [redacted]",
  );
  const capture = async (clip) =>
    new Uint8Array(
      Buffer.from(
        (
          await cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
            clip,
          })
        ).data,
        "base64",
      ),
    );
  const png = await privacy.screenshot(capture);
  const inspect = async (bytes, points, width = 800, height = 600) =>
    canvasPage.evaluate(
      async ({ png, samples, logicalWidth, logicalHeight }) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(png)], { type: "image/png" }),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const pixels = samples.map(([x, y]) =>
          Array.from(
            context.getImageData(
              Math.floor((x * bitmap.width) / logicalWidth),
              Math.floor((y * bitmap.height) / logicalHeight),
              1,
              1,
            ).data,
          ),
        );
        bitmap.close();
        return { width: canvas.width, height: canvas.height, pixels };
      },
      { png: Array.from(bytes), samples: points, logicalWidth: width, logicalHeight: height },
    );
  const image = await inspect(png, [
    [50, 60],
    [50, 140],
    [50, 220],
    [50, 300],
    [400, 70],
  ]);
  assert.ok(image.width >= 800);
  assert.equal(image.width / 800, image.height / 600);
  for (const pixel of image.pixels.slice(0, 4)) assert.deepEqual(pixel, [0, 0, 0, 255]);
  assert.deepEqual(image.pixels[4], [255, 255, 0, 255]);
  const cropped = await privacy.screenshot(capture, {
    x: 20,
    y: 40,
    width: 180,
    height: 50,
    scale: 1,
  });
  const crop = await inspect(cropped, [[50, 25]], 180, 50);
  assert.deepEqual(crop.pixels[0], [0, 0, 0, 255]);
  await page.evaluate(() => window.scrollTo(0, 100));
  const scrolled = await privacy.screenshot(capture);
  const scroll = await inspect(scrolled, [
    [50, 40],
    [50, 120],
    [50, 200],
  ]);
  for (const pixel of scroll.pixels) assert.deepEqual(pixel, [0, 0, 0, 255]);
  // Existing capture handlers can suppress DOM-based takeover listeners. The
  // privacy boundary must independently withhold unknown transient values.
  await page.evaluate(() => {
    const input = document.querySelector("#password");
    input.value = "";
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup"])
      window.addEventListener(
        type,
        (event) => {
          if (event.key === "Enter") {
            console.log(input.value);
            input.value = "";
          }
          event.stopImmediatePropagation();
        },
        true,
      );
  });
  const send = (method, params) => cdp.send(method, params);
  const protectedDriver = new TabDriver(send, {
    mode: "full",
    scope: null,
    url: page.url(),
    title: "Privacy test",
    privacy: new PrivacyGuard(send),
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    void protectedDriver.onEvent("Runtime.consoleAPICalled", params);
  });
  await protectedDriver.initialize();
  await page.locator("#password").focus();
  await page.keyboard.type("FAKE-PRIVATE-123");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#password").inputValue(), "");
  await page.evaluate(() => document.body.replaceChildren());
  for (const tool of ["browser_console_messages", "browser_network_requests", "browser_evaluate"])
    await assert.rejects(protectedDriver.execute(tool, { function: "() => 1" }), {
      code: "privacy_denied",
    });
  assert.ok(!JSON.stringify(protectedDriver).includes("FAKE-PRIVATE-123"));
  console.log(
    "PASS: real Chromium protected-field pixel masks at DPR 2/crop/scroll, ordinary pixels preserved; preexisting capture handlers cannot expose typed/logged/cleared protected values through diagnostics or scripting",
  );
} finally {
  await browser.close();
}
