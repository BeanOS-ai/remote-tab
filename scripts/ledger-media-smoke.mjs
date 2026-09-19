// Independent readers validate generated media; no fixture server or external network.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome bun scripts/ledger-media-smoke.mjs
import assert from "node:assert/strict";
import { makeLedgerZip } from "../packages/extension/src/archive.ts";
import { GifEncoder, quantize } from "../packages/extension/src/gif.ts";

const width = 32;
const height = 16;
const sessionId = "981c45d317a64eee93cbbbb1573f9114";
const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const encode = () => {
  const gif = new GifEncoder(width, height, sessionId);
  for (const color of colors) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) rgba.set([...color, 255], index * 4);
    gif.addFrame(quantize(rgba));
  }
  gif.addFrame(Uint8Array.from({ length: width * height }, (_, index) => index & 255));
  return gif.finish();
};
const gif = encode();
assert.deepEqual(gif, encode(), "GIF bytes must be reproducible");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Media decoder fixture</title>",
    }),
  );
  const page = await context.newPage();
  await page.goto("https://ledger-media.test/");
  const decoded = await page.evaluate(
    async (bytes) => {
      if (typeof ImageDecoder !== "function")
        throw new Error("Chromium ImageDecoder is unavailable");
      const decoder = new ImageDecoder({ data: new Uint8Array(bytes), type: "image/gif" });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const frames = [];
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
        const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
        const rgba = new Uint8Array(image.allocationSize({ format: "RGBA" }));
        await image.copyTo(rgba, { format: "RGBA" });
        frames.push({
          width: image.displayWidth,
          height: image.displayHeight,
          duration: image.duration,
          timestamp: image.timestamp,
          samples: [0, 239, 240, 255, 256, 511].map((pixel) => [
            ...rgba.subarray(pixel * 4, pixel * 4 + 4),
          ]),
        });
        image.close();
      }
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 1, 1);
      const png = [
        ...new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()),
      ];
      const result = { frames, infinite: track.repetitionCount === Number.POSITIVE_INFINITY, png };
      decoder.close();
      return result;
    },
    [...gif],
  );
  assert.equal(decoded.frames.length, 4);
  assert.equal(decoded.infinite, true);
  for (const [index, frame] of decoded.frames.entries()) {
    assert.equal(frame.width, width);
    assert.equal(frame.height, height);
    assert.equal(frame.duration, 1_000_000);
    assert.equal(frame.timestamp, index * 1_000_000);
    if (index < colors.length)
      for (const sample of frame.samples) assert.deepEqual(sample, [...colors[index], 255]);
    else
      for (const [sampleIndex, pixel] of [0, 239, 240, 255, 256, 511].entries()) {
        const color = pixel & 255;
        assert.deepEqual(frame.samples[sampleIndex], [
          Math.round(((color >> 5) * 255) / 7),
          Math.round((((color >> 2) & 7) * 255) / 7),
          (color & 3) * 85,
          255,
        ]);
      }
  }
  const reference = {
    blob_id: "shot",
    nonce: "nonce",
    role: "browser",
    prev_hash: "",
    mime_type: "image/png",
  };
  const ledger = {
    sessionId,
    status: {
      id: sessionId,
      state: "stopped",
      expires_at: "2026-01-01T00:00:00Z",
      last_seq: 1,
      last_hash: "hash",
      redeemed: true,
    },
    entries: [
      {
        message: {
          seq: 1,
          role: "browser",
          prev_hash: "",
          hash: "hash",
          nonce: "nonce",
          ciphertext: "ciphertext",
          created_at: "2026-01-01T00:00:00Z",
        },
        envelope: { v: 1, id: "result", kind: "result", body: { screenshot: reference, ok: true } },
        attachments: [
          { reference, bytes: new Uint8Array(decoded.png) },
          {
            reference: { ...reference, blob_id: "binary", mime_type: "application/octet-stream" },
            bytes: new Uint8Array([0, 255, 128, 1, 2]),
          },
        ],
      },
    ],
  };
  const zip = makeLedgerZip(ledger);
  assert.deepEqual(zip, makeLedgerZip(ledger), "ZIP bytes must be reproducible");
  const python = Bun.which("python3");
  if (!python)
    throw new Error("Independent ZIP validation requires Python 3's standard-library zipfile");
  const reader = Bun.spawn(
    [
      python,
      "-c",
      `import io,json,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
names=z.namelist()
assert names==['blobs/000001-1.bin','ledger.json','shots/000001-0.png']
assert z.read(names[0])==bytes([0,255,128,1,2])
assert z.read(names[2]).startswith(bytes([137,80,78,71,13,10,26,10]))
manifest=json.loads(z.read('ledger.json'))
assert manifest['entries'][0]['attachments'][0]['file']=='shots/000001-0.png'
assert manifest['entries'][0]['attachments'][1]['file']=='blobs/000001-1.bin'
for f in z.infolist():
 assert f.compress_type==zipfile.ZIP_STORED
 assert f.date_time==(1980,1,1,0,0,0)
print(json.dumps({'files':len(names),'sessionId':manifest['sessionId']}))
`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  reader.stdin.write(zip);
  reader.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(reader.stdout).text(),
    new Response(reader.stderr).text(),
    reader.exited,
  ]);
  assert.equal(exit, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { files: 3, sessionId });
  console.log(
    "PASS: Chromium ImageDecoder verifies four deterministic GIF frames, RGB332 colors across LZW clear boundaries, 1s timing and looping; Python zipfile verifies stored ZIP CRCs, CLI paths, payloads and fixed timestamps",
  );
} finally {
  await browser.close();
}
