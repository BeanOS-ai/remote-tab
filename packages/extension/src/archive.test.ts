import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobReference, Ledger } from "@remote-tab/client";
import { exportLedger } from "../../cli/src/index";
import { makeLedgerZip, screenshots } from "./archive";
import { CONTROL_EVENTS_NOTE, type ExtensionLedger } from "./control-events";

const reference: BlobReference = {
  blob_id: "shot",
  nonce: "nonce",
  role: "browser",
  prev_hash: "prior",
  mime_type: "image/png",
};
function fixture(): Ledger {
  return {
    sessionId: "ledger-session",
    status: {
      id: "ledger-session",
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
        envelope: {
          v: 1,
          id: "result",
          kind: "result",
          body: { screenshot: { ...reference }, ok: true },
        },
        attachments: [
          { reference: { ...reference }, bytes: new Uint8Array([137, 80, 78, 71]) },
          {
            reference: { ...reference, blob_id: "ordinary", mime_type: "application/octet-stream" },
            bytes: new TextEncoder().encode("123456789"),
          },
        ],
      },
    ],
  };
}

function readStored(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  let central = view.getUint32(end + 16, true);
  const files = new Map<string, { bytes: Uint8Array; crc: number; date: number; time: number }>();
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    expect(view.getUint32(central, true)).toBe(0x02014b50);
    const nameSize = view.getUint16(central + 28, true);
    const name = new TextDecoder().decode(zip.subarray(central + 46, central + 46 + nameSize));
    const offset = view.getUint32(central + 42, true);
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 8, true)).toBe(0);
    expect(view.getUint32(offset + 14, true)).toBe(view.getUint32(central + 16, true));
    const data =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    files.set(name, {
      bytes: zip.slice(data, data + view.getUint32(offset + 22, true)),
      crc: view.getUint32(offset + 14, true),
      time: view.getUint16(offset + 10, true),
      date: view.getUint16(offset + 12, true),
    });
    central +=
      46 + nameSize + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  expect(central).toBe(end);
  return files;
}

test("stored ZIP exactly matches CLI ledger export and preserves binary attachments", async () => {
  const ledger = fixture();
  const files = readStored(makeLedgerZip(ledger));
  expect([...files.keys()]).toEqual(["blobs/000001-1.bin", "ledger.json", "shots/000001-0.png"]);
  const temporary = await mkdtemp(join(tmpdir(), "ledger-archive-test-"));
  try {
    const output = join(temporary, "cli");
    await exportLedger(ledger, output);
    for (const [path, file] of files)
      expect(file.bytes).toEqual(new Uint8Array(await readFile(join(output, path))));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  expect(files.get("blobs/000001-1.bin")?.crc).toBe(0xcbf43926); // Standard CRC32 check vector.
  for (const file of files.values()) {
    expect(file.time).toBe(0);
    expect(file.date).toBe(33);
  }
});

test("archive bytes are deterministic and contain no source attachment byte arrays in JSON", () => {
  const ledger = fixture();
  expect(makeLedgerZip(ledger)).toEqual(makeLedgerZip(structuredClone(ledger)));
  const metadata = JSON.parse(
    new TextDecoder().decode(readStored(makeLedgerZip(ledger)).get("ledger.json")?.bytes),
  );
  expect(metadata.entries[0].attachments[0]).toEqual({ reference, file: "shots/000001-0.png" });
  expect(metadata.entries[0].attachments[0].bytes).toBeUndefined();
});

test("only exact screenshot references become frames, not PNG blobs or partial matches", () => {
  const ledger = fixture();
  const entry = ledger.entries[0];
  entry.attachments.push(
    { reference: { ...reference, nonce: "different" }, bytes: new Uint8Array([1]) },
    { reference: { ...reference, blob_id: "other-png" }, bytes: new Uint8Array([2]) },
  );
  expect(screenshots(ledger)).toEqual([{ seq: 1, index: 0, bytes: entry.attachments[0].bytes }]);
  const files = readStored(makeLedgerZip(ledger));
  expect(files.has("blobs/000001-2.bin")).toBe(true);
  expect(files.has("blobs/000001-3.bin")).toBe(true);
  entry.envelope.body = { screenshot: { ...reference, mime_type: "image/jpeg" } };
  expect(screenshots(ledger)).toEqual([]);
});

test("invalid sequence paths, duplicate entries and file count overflow are explicit errors", () => {
  const ledger = fixture();
  ledger.entries[0].message.seq = -1;
  expect(() => makeLedgerZip(ledger)).toThrow("sequence");
  ledger.entries[0].message.seq = 1;
  ledger.entries.push(structuredClone(ledger.entries[0]));
  expect(() => makeLedgerZip(ledger)).toThrow("sequence");
  ledger.entries.pop();
  ledger.entries[0].attachments = Array.from(
    { length: 10_000 },
    () => ledger.entries[0].attachments[0],
  );
  expect(() => makeLedgerZip(ledger)).toThrow("10000 files");
});

test("empty ledger still produces an independently addressable ledger.json", () => {
  const ledger = fixture();
  ledger.entries = [];
  expect([...readStored(makeLedgerZip(ledger)).keys()]).toEqual(["ledger.json"]);
  expect(screenshots(ledger)).toEqual([]);
});

test("ZIP retains Pause without later commands as separate, explicitly unauthenticated local metadata", () => {
  const ledger: ExtensionLedger = {
    ...fixture(),
    entries: [],
    controlEvents: [
      { action: "pause", timestamp: "2026-09-19T12:00:00.000Z" },
      { action: "resume", timestamp: "2026-09-19T12:01:00.000Z" },
      { action: "pause", timestamp: "2026-09-19T12:02:00.000Z" },
    ],
  };
  const files = readStored(makeLedgerZip(ledger));
  expect([...files.keys()]).toEqual(["ledger.json"]);
  const saved = JSON.parse(new TextDecoder().decode(files.get("ledger.json")?.bytes));
  expect(saved.entries).toEqual([]);
  expect(saved.controlEvents).toEqual(ledger.controlEvents);
  expect(saved.controlEventsNote).toBe(CONTROL_EVENTS_NOTE);
  expect(saved.controlEventsNote).toContain("not part of the authenticated command chain");
});
