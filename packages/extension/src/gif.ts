// Original MIT implementation. Format: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
// Literal LZW codes with frequent clears keep every code at 9 bits (Appendix F).
const MAX_PIXELS = 1_048_576;
const MAX_FRAMES = 300;
const MAX_BYTES = 128 * 1024 * 1024;
const encoder = new TextEncoder();

/** Fixed RGB332 quantization. Alpha is composited onto white, never silently discarded. */
export function quantize(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  if (
    !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
    !rgba.byteLength ||
    rgba.byteLength % 4 ||
    rgba.byteLength / 4 > MAX_PIXELS
  )
    throw new Error("RGBA frame must contain 1 to 1048576 complete pixels");
  const indexed = new Uint8Array(rgba.byteLength / 4);
  for (let pixel = 0; pixel < indexed.length; pixel++) {
    const offset = pixel * 4;
    const alpha = rgba[offset + 3];
    const channel = (value: number) => Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    indexed[pixel] =
      (channel(rgba[offset]) & 0xe0) |
      ((channel(rgba[offset + 1]) & 0xe0) >> 3) |
      (channel(rgba[offset + 2]) >> 6);
  }
  return indexed;
}

function blocks(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length + Math.ceil(bytes.length / 255) + 1);
  let at = 0;
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const chunk = bytes.subarray(offset, offset + 255);
    output[at++] = chunk.length;
    output.set(chunk, at);
    at += chunk.length;
  }
  return output; // Zero block terminator is supplied by initialization.
}

function literals(pixels: Uint8Array): Uint8Array {
  const count = pixels.length + Math.ceil(pixels.length / 240) + 1;
  const bytes = new Uint8Array(Math.ceil((count * 9) / 8));
  let bit = 0;
  const write = (code: number) => {
    const index = bit >> 3;
    const shift = bit & 7;
    bytes[index] |= (code << shift) & 255;
    bytes[index + 1] |= code >> (8 - shift);
    bit += 9;
  };
  for (let offset = 0; offset < pixels.length; offset += 240) {
    write(256); // Clear before the decoder's dictionary could require 10-bit codes.
    for (const pixel of pixels.subarray(offset, offset + 240)) write(pixel);
  }
  write(257);
  return bytes;
}

/** Deterministic GIF89a, RGB332 palette, 1-second full-canvas frames and infinite looping. */
export class GifEncoder {
  private readonly chunks: Uint8Array[] = [];
  private readonly pixels: number;
  private count = 0;
  private size = 1; // Trailer.
  private finished = false;

  constructor(
    private readonly width: number,
    private readonly height: number,
    sessionId: string,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 4096 ||
      height > 4096 ||
      width * height > MAX_PIXELS
    )
      throw new Error("GIF dimensions must be 1..4096 with at most 1048576 pixels");
    if (
      typeof sessionId !== "string" ||
      !sessionId.length ||
      encoder.encode(sessionId).length > 128 ||
      [...sessionId].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("GIF session ID must contain 1..128 UTF-8 bytes without control characters");
    this.pixels = width * height;
    const header = new Uint8Array(13 + 768);
    header.set(encoder.encode("GIF89a"));
    const view = new DataView(header.buffer);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
    header[10] = 0xf7; // Global palette, 8-bit color resolution, 256 entries.
    for (let color = 0; color < 256; color++) {
      header[13 + color * 3] = Math.round(((color >> 5) * 255) / 7);
      header[14 + color * 3] = Math.round((((color >> 2) & 7) * 255) / 7);
      header[15 + color * 3] = (color & 3) * 85;
    }
    this.append(header);
    this.append(new Uint8Array([0x21, 0xff, 11, ...encoder.encode("NETSCAPE2.0"), 3, 1, 0, 0, 0]));
    this.append(new Uint8Array([0x21, 0xfe]));
    this.append(blocks(encoder.encode(`remote-tab session ${sessionId}`)));
  }

  private append(bytes: Uint8Array): void {
    if (this.size + bytes.byteLength > MAX_BYTES) throw new Error("GIF exceeds 128 MiB");
    this.size += bytes.byteLength;
    this.chunks.push(bytes);
  }

  addFrame(indexed: Uint8Array): void {
    if (this.finished) throw new Error("GIF is already finished");
    if (!(indexed instanceof Uint8Array) || indexed.length !== this.pixels)
      throw new Error("GIF frame length does not match its dimensions");
    if (this.count >= MAX_FRAMES) throw new Error("GIF exceeds 300 frames");
    const compressed = blocks(literals(indexed));
    const frame = new Uint8Array(19 + compressed.length);
    frame.set([0x21, 0xf9, 4, 4, 100, 0, 0, 0, 0x2c]); // Disposal=keep, delay=100 hundredths.
    const view = new DataView(frame.buffer);
    view.setUint16(13, this.width, true);
    view.setUint16(15, this.height, true);
    frame[18] = 8; // LZW minimum code size; no local palette/interlacing.
    frame.set(compressed, 19);
    this.append(frame);
    this.count++;
  }

  finish(): Uint8Array {
    if (!this.count) throw new Error("GIF requires at least one frame");
    this.finished = true;
    const output = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    output[offset] = 0x3b;
    return output;
  }
}
