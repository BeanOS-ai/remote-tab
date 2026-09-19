// Explicit runner, never discovered by `bun test`. No credentials or external fixture sites.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, createSession } from "../../packages/client/src/index.ts";
import { verifyChain } from "../../packages/protocol/src/crypto.ts";
import { SECRETS, fixtureResponse } from "./fixture.mjs";
const root = new URL("../../", import.meta.url).pathname;
const generate = Bun.spawn([process.execPath, "scripts/generate-bootstrap.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
assert.equal(await generate.exited, 0, "Bootstrap generation failed");
const { createApp, MemoryStore, StaticKeyResolver } = await import(
  "../../packages/server/src/index.ts"
);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const temporary = await mkdtemp(join(tmpdir(), "remote-tab-browser-"));
const store = new MemoryStore();
const app = createApp({
  store,
  keyResolver: new StaticKeyResolver(new Map([["browser-test", "disposable-test-key"]]), {
    defaultQps: 0,
  }),
  anonymousQps: 1000,
  usageSink: { record() {} },
});
const serve = (request) =>
  new URL(request.url).pathname.startsWith("/v1/") ? app.fetch(request) : fixtureResponse(request);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serve });
const origin = server.url.origin;
const otherServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtureResponse });
const otherOrigin = otherServer.url.origin.replace("127.0.0.1", "localhost");
const protocolFetch =
  process.env.BROWSER_INPROCESS_HTTP === "1"
    ? (request) => app.fetch(request)
    : (request) => fetch(request);
const options = {
  serverUrl: origin,
  apiKey: "disposable-test-key",
  fetch: protocolFetch,
  timeoutMs: 30000,
  pollWaitSeconds: 1,
  pollIntervalMs: 20,
};
let context;
let worker;
let stage = "launch";
const failures = [];
const report = (message) => {
  stage = message;
  console.log(`BROWSER: ${message}`);
};
const pngBytes = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.screenshot?.mime_type, "image/png");
  const bytes = new Uint8Array(result.attachments[0].bytes);
  assert.ok(bytes.length > 100);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
};
const refFor = (text, name) => {
  const line = text
    .split("\n")
    .find((line) => line.includes(`"${name}"`) && line.includes("[ref="));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  assert.ok(ref, `Missing ${name} snapshot ref in ${text}`);
  return ref;
};
async function popupFor(tab) {
  await tab.bringToFront();
  const ready = context.waitForEvent("page");
  await worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `chrome-extension://${new URL(worker.url()).host}/popup.html`,
  );
  const popup = await ready;
  await popup.waitForLoadState();
  await popup.waitForFunction(() => document.querySelector("#tab").textContent.includes("/"));
  return popup;
}
async function share(tab, mode) {
  const popup = await popupFor(tab);
  const created = await createSession(options);
  await popup.locator("#code").evaluate((input, code) => {
    input.value = code;
  }, created.code);
  await popup.locator(`input[value="${mode}"]`).check();
  await tab.bringToFront();
  await popup.locator("#consent").evaluate((form) => form.requestSubmit());
  const hello = await created.session.waitReady();
  assert.equal(hello.mode, mode);
  assert.equal(hello.scope, "127.0.0.1");
  assert.equal(hello.url, tab.url());
  assert.equal(hello.title, "Remote Tab offline fixture");
  return { ...created, popup };
}
async function clickControl(popup, id) {
  await popup.locator(`#${id}`).evaluate((button) => button.click());
}
async function stop(tab, popup, session) {
  const ledgerReady = context.waitForEvent("page", {
    predicate: (page) => page.url().includes("ledger.html"),
  });
  await clickControl(popup, "stop");
  const ledger = await ledgerReady;
  await ledger.locator('#status[data-state="verified"]').waitFor({ timeout: 30000 });
  assert.equal((await session.status()).state, "stopped");
  const detached = await worker.evaluate(async (url) => {
    const target = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    try {
      await chrome.debugger.sendCommand({ tabId: target.id }, "Runtime.evaluate", {
        expression: "1",
      });
      return false;
    } catch (error) {
      return /not attached/i.test(String(error));
    }
  }, tab.url());
  assert.equal(detached, true, "Stop must detach the extension's real chrome.debugger target");
  await assert.rejects(session.send("browser_snapshot"), { code: "session_not_active" });
  return ledger;
}
async function samplePixels(page, bytes, points) {
  return page.evaluate(
    async ({ bytes, points }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const pixels = points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      bitmap.close();
      return pixels;
    },
    { bytes: [...bytes], points },
  );
}
function zipFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, "Store archive uses uncompressed entries");
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return files;
}
try {
  const extension = join(temporary, "extension");
  const build = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { buildExtension } from "./packages/extension/build.ts"; await buildExtension(process.env.REMOTE_TAB_SERVER_ORIGIN, process.env.BROWSER_BUILD_OUT)',
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, REMOTE_TAB_SERVER_ORIGIN: origin, BROWSER_BUILD_OUT: extension },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  assert.equal(await build.exited, 0, "Extension build failed");
  try {
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      headless: true,
      channel: "chromium",
      viewport: null,
      acceptDownloads: true,
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
        : {}),
      args: [
        "--window-size=1100,900",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
  } catch (error) {
    if (
      !/Executable doesn't exist|executable doesn't exist|error while loading shared libraries|Host system is missing dependencies|ENOENT.*chrom/i.test(
        String(error),
      )
    )
      throw error;
    console.log("SKIP: Chromium executable or required host libraries are unavailable");
  }
  if (context) {
    context.setDefaultTimeout(15000);
    // Explicit opt-in for environments where loopback sockets are unavailable. Chrome still
    // executes the installed worker's native fetch and debugger APIs; only HTTP delivery is routed.
    if (process.env.BROWSER_INPROCESS_HTTP === "1") {
      await context.route(/^http:\/\/(127\.0\.0\.1|localhost):\d+\//, async (route) => {
        const incoming = route.request();
        const response = await serve(
          new Request(incoming.url(), {
            method: incoming.method(),
            headers: incoming.headers(),
            ...(incoming.postDataBuffer() ? { body: incoming.postDataBuffer() } : {}),
          }),
        );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      report("explicit in-process HTTP delivery (real extension fetch/CDP)");
    }
    worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
    const otherTab = await context.newPage();
    await otherTab.goto(`${otherOrigin}/form`);
    assert.equal(await otherTab.title(), "Remote Tab offline fixture");
    await otherTab.close();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => failures.push(error.message));
    await tab.goto(`${origin}/form`);
    report("MV3 worker and local form loaded");
    const { session, popup } = await share(tab, "act");
    report("authenticated act hello");
    const snapshot = await session.send("browser_snapshot");
    assert.equal(snapshot.ok, true);
    const name = refFor(snapshot.result.text, "Name");
    const submit = refFor(snapshot.result.text, "Submit");
    pngBytes(await session.send("browser_type", { ref: name, text: "Ada" }));
    pngBytes(await session.send("browser_click", { ref: name }));
    pngBytes(await session.send("browser_press_key", { key: "End" }));
    pngBytes(await session.send("browser_press_key", { key: "Space" }));
    pngBytes(await session.send("browser_press_key", { key: "Shift+b" }));
    assert.equal(await tab.locator("#name").inputValue(), "Ada B");
    pngBytes(await session.send("browser_click", { ref: submit }));
    assert.equal(await tab.locator("#result").textContent(), "Submitted: Ada B");
    assert.equal(
      (await session.send("browser_evaluate", { function: "() => 42" })).error.code,
      "mode_denied",
    );
    assert.equal(
      (await session.send("browser_navigate", { url: `${otherOrigin}/form` })).error.code,
      "scope_denied",
    );
    assert.equal(tab.url(), `${origin}/form`);
    report("real AX refs, type/click/key, PNGs and cross-host scope denial");
    let handedOff = false;
    const handoff = session.handoff("Review the disposable form, then press Done").then(() => {
      handedOff = true;
    });
    await popup.locator("#handoff").waitFor({ state: "visible" });
    assert.equal(handedOff, false);
    await assert.rejects(
      AgentSession.resume(session.exportState(), options).send("browser_click", { ref: submit }),
      { code: "handoff_pending" },
    );
    await clickControl(popup, "done");
    await handoff;
    await tab.bringToFront();
    await tab.keyboard.press("ArrowLeft");
    await popup.locator("#paused").waitFor({ state: "visible" });
    const beforePaused = await tab.locator("#name").inputValue();
    assert.equal(
      (await session.send("browser_type", { ref: name, text: "must-not-run" })).error.code,
      "paused",
    );
    assert.equal(await tab.locator("#name").inputValue(), beforePaused);
    await clickControl(popup, "resume");
    assert.equal((await session.send("browser_snapshot")).ok, true);
    report("handoff Done and trusted human input pause/Resume");
    pngBytes(await session.send("browser_navigate", { url: `${origin}/privacy` }));
    const privateSnapshot = await session.send("browser_snapshot");
    const privateShot = pngBytes(await session.send("browser_take_screenshot"));
    for (const secret of Object.values(SECRETS))
      assert.ok(!JSON.stringify(privateSnapshot).includes(secret));
    const points = [
      [235, 335],
      [235, 405],
      [235, 475],
      [510, 350],
    ];
    const rawPixels = await samplePixels(popup, new Uint8Array(await tab.screenshot()), points);
    assert.deepEqual(rawPixels, [
      [255, 0, 0, 255],
      [0, 128, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ]);
    assert.deepEqual(await samplePixels(popup, privateShot, points), [
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [255, 255, 0, 255],
    ]);
    assert.equal(await tab.locator("#password").inputValue(), SECRETS.password);
    assert.equal(await tab.locator("#otp").inputValue(), SECRETS.otp);
    assert.equal(await tab.locator("#card").inputValue(), SECRETS.card);
    for (const tool of ["browser_console_messages", "browser_network_requests"])
      assert.equal((await session.send(tool)).error.code, "privacy_denied");
    report(
      "protected password/OTP/card absent from snapshot; real PNG masks with DOM/raw-pixel controls",
    );
    const ledgerPage = await stop(tab, popup, session);
    const history = await session.ledger();
    assert.deepEqual(
      await verifyChain(
        history.sessionId,
        history.entries.map(({ message }) => ({ ...message, prevHash: message.prev_hash })),
      ),
      { ok: true },
    );
    assert.ok(history.entries.some((entry) => entry.attachments.length));
    for (const secret of Object.values(SECRETS))
      assert.ok(!JSON.stringify(history.entries.map((entry) => entry.envelope)).includes(secret));
    const downloadReady = ledgerPage.waitForEvent("download");
    await ledgerPage.locator("#download-zip").click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), `${history.sessionId}-ledger.zip`);
    const archive = zipFiles(new Uint8Array(await Bun.file(await download.path()).arrayBuffer()));
    assert.ok(archive.has("ledger.json"));
    const exported = JSON.parse(new TextDecoder().decode(archive.get("ledger.json")));
    assert.equal(exported.sessionId, history.sessionId);
    assert.deepEqual(exported.status, history.status);
    assert.deepEqual(
      await verifyChain(
        exported.sessionId,
        exported.entries.map(({ message }) => ({ ...message, prevHash: message.prev_hash })),
      ),
      { ok: true },
    );
    assert.deepEqual(
      exported.entries.map((entry) => entry.envelope),
      history.entries.map((entry) => entry.envelope),
    );
    for (const [index, entry] of exported.entries.entries()) {
      assert.equal(entry.attachments.length, history.entries[index].attachments.length);
      for (const [attachmentIndex, attachment] of entry.attachments.entries()) {
        assert.match(attachment.file, /^shots\/\d+-\d+\.png$/);
        assert.deepEqual(
          attachment.reference,
          history.entries[index].attachments[attachmentIndex].reference,
        );
        assert.deepEqual(
          archive.get(attachment.file),
          new Uint8Array(history.entries[index].attachments[attachmentIndex].bytes),
        );
      }
    }
    const pngs = [...archive].filter(([name]) => name.endsWith(".png"));
    assert.equal(
      pngs.length,
      history.entries.reduce((sum, entry) => sum + entry.attachments.length, 0),
    );
    assert.ok(pngs.some(([, bytes]) => Buffer.from(bytes).equals(Buffer.from(privateShot))));
    await ledgerPage.locator("#render-gif").click();
    await ledgerPage.waitForFunction(
      () => document.querySelector("#gif-player").naturalWidth === 640,
      { timeout: 30000 },
    );
    const gifReady = ledgerPage.waitForEvent("download");
    await ledgerPage.locator("#download-gif").click();
    const gifDownload = await gifReady;
    assert.equal(gifDownload.suggestedFilename(), `${history.sessionId}.gif`);
    const gifBytes = new Uint8Array(await Bun.file(await gifDownload.path()).arrayBuffer());
    assert.equal(new TextDecoder().decode(gifBytes.subarray(0, 6)), "GIF89a");
    assert.ok(new TextDecoder().decode(gifBytes).includes(history.sessionId));
    const decoded = await ledgerPage.evaluate(
      async (bytes) => {
        const decoder = new ImageDecoder({ data: new Uint8Array(bytes), type: "image/gif" });
        try {
          await decoder.tracks.ready;
          const track = decoder.tracks.selectedTrack;
          const frames = [];
          for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
            const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
            frames.push({
              width: image.displayWidth,
              height: image.displayHeight,
              duration: image.duration,
            });
            image.close();
          }
          return { frames, loop: track.repetitionCount === Number.POSITIVE_INFINITY };
        } finally {
          decoder.close();
        }
      },
      [...gifBytes],
    );
    assert.equal(decoded.frames.length, pngs.length);
    assert.equal(decoded.loop, true);
    for (const frame of decoded.frames)
      assert.deepEqual(frame, { width: 640, height: 360, duration: 1_000_000 });
    report("Stop detached; verified decrypted ledger, exact PNG ZIP export and decoded GIF frames");
    await popup.close();
    await ledgerPage.close();
    await tab.goto(`${origin}/form`);
    const read = await share(tab, "read");
    const readSnapshot = await read.session.send("browser_snapshot");
    for (const [tool, args] of [
      ["browser_click", { ref: refFor(readSnapshot.result.text, "Submit") }],
      ["browser_type", { ref: refFor(readSnapshot.result.text, "Name"), text: "denied" }],
      ["browser_press_key", { key: "x" }],
    ])
      assert.equal((await read.session.send(tool, args)).error.code, "mode_denied");
    assert.equal(await tab.locator("#name").inputValue(), "");
    assert.equal(await tab.locator("#result").textContent(), "");
    await (await stop(tab, read.popup, read.session)).close();
    await read.popup.close();
    report("read-only mode blocks real input without DOM changes");
    // A new share on the exact same document must not mistake the previous monitor's
    // listeners for hostile page handlers. Do not reload between these two shares.
    const documentIdentity = await tab.evaluate(() => performance.timeOrigin);
    const full = await share(tab, "full");
    assert.equal(await tab.evaluate(() => performance.timeOrigin), documentIdentity);
    assert.equal(
      (await full.session.send("browser_evaluate", { function: "() => 42" })).result,
      42,
    );
    pngBytes(await full.session.send("browser_navigate", { url: `${origin}/privacy` }));
    assert.equal(
      (
        await full.session.send("browser_evaluate", {
          function: "() => document.querySelector('#password').value",
        })
      ).error.code,
      "privacy_denied",
    );
    await (await stop(tab, full.popup, full.session)).close();
    await full.popup.close();
    report("full mode scripting works before protected fields and denies it afterward");
    const victim = await createSession({
      ...options,
      helloGraceMs: 150,
      timeoutMs: 3000,
      pollWaitSeconds: 0,
    });
    const stolen = await protocolFetch(
      new Request(`${origin}/v1/sessions/${victim.session.sessionId}/redeem`, { method: "POST" }),
    );
    assert.equal(stolen.status, 200);
    await tab.goto(`${origin}/form`);
    const usedPopup = await popupFor(tab);
    await usedPopup.locator("#code").evaluate((input, code) => {
      input.value = code;
    }, victim.code);
    await tab.bringToFront();
    await usedPopup.locator("#consent").evaluate((form) => form.requestSubmit());
    await usedPopup.waitForFunction(() =>
      document.querySelector("#error").textContent.includes("already used"),
    );
    await assert.rejects(victim.session.waitReady(), { code: "hijack_suspected" });
    assert.equal((await victim.session.status()).state, "stopped");
    assert.deepEqual(failures, []);
    report("secretless redeemer cannot authenticate hello; waitReady detects hijack and stops");
    console.log(
      "PASS: installed MV3 extension, actual chrome.debugger, encrypted AgentSession protocol and offline fixture assertions",
    );
  }
} catch (error) {
  console.error(
    `FAIL at ${stage}: ${String(error.stack || error)
      .replace(/rt1\.[A-Za-z0-9_-]+/g, "[private code]")
      .replace(/Bearer\s+[^\s\"\']+/gi, "Bearer [redacted]")}`,
  );
  if (context) {
    for (const page of context.pages())
      if (page.url().includes("popup.html"))
        console.error(
          "Popup:",
          await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable"),
        );
  }
  process.exitCode = 1;
} finally {
  await context?.close();
  await server.stop(true);
  await otherServer.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
