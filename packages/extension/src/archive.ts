import type { Attachment, BlobReference, Ledger, LedgerEntry } from "@remote-tab/client";
import { record } from "./chrome";

const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function isScreenshot(entry: LedgerEntry, attachment: Attachment): boolean {
  const body = entry.envelope.body;
  if (!record(body) || !record(body.screenshot)) return false;
  const reference = body.screenshot;
  return (
    reference.mime_type === "image/png" &&
    (
      ["blob_id", "nonce", "role", "prev_hash", "mime_type"] satisfies (keyof BlobReference)[]
    ).every((key) => reference[key] === attachment.reference[key])
  );
}

function checkEntries(ledger: Ledger): void {
  let last = 0;
  for (const entry of ledger.entries) {
    if (!Number.isSafeInteger(entry.message.seq) || entry.message.seq <= last)
      throw new Error("Ledger entries must have increasing positive sequence numbers");
    last = entry.message.seq;
  }
}

/** Exact authenticated screenshot references only; an unrelated PNG blob is not a frame. */
export function screenshots(ledger: Ledger): { seq: number; index: number; bytes: Uint8Array }[] {
  checkEntries(ledger);
  return ledger.entries.flatMap((entry) =>
    entry.attachments.flatMap((attachment, index) =>
      isScreenshot(entry, attachment)
        ? [{ seq: entry.message.seq, index, bytes: attachment.bytes }]
        : [],
    ),
  );
}

/** Source-owned stored ZIP, with the CLI exportLedger JSON/path layout and fixed metadata. */
export function makeLedgerZip(ledger: Ledger): Uint8Array {
  checkEntries(ledger);
  const files: { name: string; bytes: Uint8Array }[] = [];
  let size = 0;
  const add = (name: string, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array)) throw new Error("Ledger attachment must contain bytes");
    if (files.length >= MAX_FILES) throw new Error("Ledger ZIP exceeds 10000 files");
    size += bytes.byteLength + 76 + encoder.encode(name).byteLength * 2;
    if (size + 22 > MAX_BYTES) throw new Error("Ledger ZIP exceeds 256 MiB");
    files.push({ name, bytes });
  };
  const entries = ledger.entries.map((entry) => ({
    message: entry.message,
    envelope: entry.envelope,
    attachments: entry.attachments.map((attachment, index) => {
      const shot = isScreenshot(entry, attachment);
      const file = `${shot ? "shots" : "blobs"}/${String(entry.message.seq).padStart(6, "0")}-${index}.${shot ? "png" : "bin"}`;
      add(file, attachment.bytes);
      return { reference: attachment.reference, file };
    }),
  }));
  add(
    "ledger.json",
    encoder.encode(
      `${JSON.stringify({ sessionId: ledger.sessionId, status: ledger.status, entries }, null, 2)}\n`,
    ),
  );
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const zip = new Uint8Array(size + 22);
  const view = new DataView(zip.buffer);
  const directory: { name: Uint8Array; bytes: Uint8Array; crc: number; offset: number }[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    directory.push({ ...file, name, crc, offset });
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 filenames, stored/no descriptor.
    view.setUint16(offset + 12, 33, true); // 1980-01-01, midnight DOS timestamp.
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, file.bytes.byteLength, true);
    view.setUint32(offset + 22, file.bytes.byteLength, true);
    view.setUint16(offset + 26, name.byteLength, true);
    zip.set(name, offset + 30);
    zip.set(file.bytes, offset + 30 + name.byteLength);
    offset += 30 + name.byteLength + file.bytes.byteLength;
  }
  const directoryStart = offset;
  for (const file of directory) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 0x0314, true); // Unix creator, version 2.0.
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 14, 33, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.bytes.byteLength, true);
    view.setUint32(offset + 24, file.bytes.byteLength, true);
    view.setUint16(offset + 28, file.name.byteLength, true);
    view.setUint32(offset + 38, 0o100600 << 16, true);
    view.setUint32(offset + 42, file.offset, true);
    zip.set(file.name, offset + 46);
    offset += 46 + file.name.byteLength;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, offset - directoryStart, true);
  view.setUint32(offset + 16, directoryStart, true);
  return zip;
}
