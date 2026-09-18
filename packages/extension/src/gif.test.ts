import { expect, test } from "bun:test";
import { GifEncoder, quantize } from "./gif";

function inspect(bytes: Uint8Array) {
  expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const palette = bytes.subarray(13, 781);
  let offset = 781;
  const frames: { width: number; height: number; data: number[] }[] = [];
  const comments: string[] = [];
  const durations: number[] = [];
  const block = () => {
    const data: number[] = [];
    while (bytes[offset]) {
      const size = bytes[offset++];
      data.push(...bytes.subarray(offset, offset + size));
      offset += size;
    }
    offset++;
    return data;
  };
  while (bytes[offset] !== 0x3b) {
    const marker = bytes[offset++];
    if (marker === 0x21) {
      const label = bytes[offset++];
      const data = block();
      if (label === 0xfe) comments.push(new TextDecoder().decode(new Uint8Array(data)));
      if (label === 0xf9) durations.push(data[1] | (data[2] << 8));
      if (label === 0xff)
        expect(new TextDecoder().decode(new Uint8Array(data.slice(0, 11)))).toBe("NETSCAPE2.0");
    } else {
      expect(marker).toBe(0x2c);
      const width = view.getUint16(offset + 4, true);
      const height = view.getUint16(offset + 6, true);
      expect(bytes[offset + 8]).toBe(0);
      offset += 9;
      expect(bytes[offset++]).toBe(8);
      frames.push({ width, height, data: block() });
    }
  }
  expect(offset).toBe(bytes.length - 1);
  return { frames, comments, durations, palette };
}

test("RGB332 quantization is deterministic and composites transparency onto white", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0,
    255, 0, 0, 128,
  ]);
  expect(quantize(rgba)).toEqual(new Uint8Array([0, 224, 28, 3, 255, 255, 237]));
  expect(quantize(rgba)).toEqual(quantize(new Uint8Array(rgba)));
  expect(() => quantize(new Uint8Array(3))).toThrow("complete pixels");
  expect(() => quantize(new Uint8Array())).toThrow("complete pixels");
});

test("GIF has stable palette, session comment, complete frames and 1-second timing", () => {
  const make = () => {
    const gif = new GifEncoder(2, 1, "session-123");
    gif.addFrame(new Uint8Array([224, 28]));
    gif.addFrame(new Uint8Array([3, 255]));
    return gif.finish();
  };
  const bytes = make();
  expect(bytes).toEqual(make());
  const result = inspect(bytes);
  expect(result.frames.map(({ width, height }) => [width, height])).toEqual([
    [2, 1],
    [2, 1],
  ]);
  expect(result.durations).toEqual([100, 100]);
  expect(result.comments).toEqual(["remote-tab session session-123"]);
  expect([...result.palette.subarray(224 * 3, 224 * 3 + 3)]).toEqual([255, 0, 0]);
  expect([...result.palette.subarray(28 * 3, 28 * 3 + 3)]).toEqual([0, 255, 0]);
  expect([...result.palette.subarray(3 * 3, 3 * 3 + 3)]).toEqual([0, 0, 255]);
});

test("literal LZW clears before dictionary growth across 240-pixel boundaries", () => {
  const gif = new GifEncoder(501, 1, "boundary");
  const pixels = Uint8Array.from({ length: 501 }, (_, index) => index & 255);
  gif.addFrame(pixels);
  const data = inspect(gif.finish()).frames[0].data;
  const codes: number[] = [];
  for (let bit = 0; bit + 9 <= data.length * 8; bit += 9) {
    const at = bit >> 3;
    codes.push(((data[at] | ((data[at + 1] ?? 0) << 8)) >> (bit & 7)) & 511);
  }
  expect(codes.filter((code) => code === 256)).toHaveLength(3);
  expect(codes.at(-1)).toBe(257);
  expect(new Uint8Array(codes.filter((code) => code < 256))).toEqual(pixels);
});

test("frame buffers and finished outputs cannot mutate later GIF results", () => {
  const gif = new GifEncoder(1, 1, "copy");
  const pixels = new Uint8Array([224]);
  gif.addFrame(pixels);
  pixels[0] = 0;
  const first = gif.finish();
  const expected = first.slice();
  first.fill(0);
  expect(gif.finish()).toEqual(expected);
  expect(() => gif.addFrame(pixels)).toThrow("finished");
});

test("dimension, frame length and frame cap violations fail instead of truncating", () => {
  for (const [width, height] of [
    [0, 1],
    [1.5, 1],
    [4097, 1],
    [1025, 1024],
  ])
    expect(() => new GifEncoder(width, height, "bounds")).toThrow("dimensions");
  expect(() => new GifEncoder(1, 1, "x".repeat(129))).toThrow("session ID");
  const gif = new GifEncoder(1, 1, "bounds");
  expect(() => gif.finish()).toThrow("at least one");
  expect(() => gif.addFrame(new Uint8Array(2))).toThrow("length");
  for (let index = 0; index < 300; index++) gif.addFrame(new Uint8Array([index & 255]));
  expect(() => gif.addFrame(new Uint8Array(1))).toThrow("300 frames");
  expect(inspect(gif.finish()).frames).toHaveLength(300);
});
