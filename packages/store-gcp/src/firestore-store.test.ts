import { describe, expect, test } from "bun:test";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { append, sessionRecord, storeContract } from "../../server/src/store-contract";
import { BlobAlreadyExists, type BlobStore } from "./blob-store";
import { GcpStore } from "./firestore-store";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;
class MemoryBlobs implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; customTime: string }>();
  async put(path: string, bytes: Uint8Array<ArrayBuffer>, customTime: Date | string) {
    if (this.objects.has(path)) throw new BlobAlreadyExists();
    this.objects.set(path, {
      bytes: new Uint8Array(bytes),
      customTime: new Date(customTime).toISOString(),
    });
  }
  async get(path: string) {
    const entry = this.objects.get(path);
    return entry ? new Uint8Array(entry.bytes) : null;
  }
}
async function cleanupStage(label: string, run: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Firestore fixture cleanup timed out: ${label}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(now: () => Date, title?: string) {
  if (!emulator)
    throw new Error("FIRESTORE_EMULATOR_HOST must be configured for integration tests");
  // Isolate admission/active as well as session documents without clearing another test's data.
  const prefix = process.env.GOOGLE_CLOUD_PROJECT || "demo-remote-tab-tests";
  const projectId = `${prefix.slice(0, 20)}-${crypto.randomUUID().slice(0, 8)}`;
  const clients = [new Firestore({ projectId }), new Firestore({ projectId })];
  const blobs = new MemoryBlobs();
  const started = Date.now();
  const trace =
    title === "concurrent appends publish one predecessor winner and a verifiable chain"
      ? (phase: string) =>
          console.info(`[Firestore append race ${projectId} +${Date.now() - started}ms] ${phase}`)
      : undefined;
  return {
    a: new GcpStore({ firestore: clients[0], blobs, now }),
    b: new GcpStore({ firestore: clients[1], blobs, now }),
    clients,
    blobs,
    trace,
    close: async () => {
      try {
        trace?.("cleanup sessions:start");
        await cleanupStage("recursiveDelete sessions", () =>
          clients[0].recursiveDelete(clients[0].collection("sessions")),
        );
        trace?.("cleanup sessions:done; admission delete:start");
        await cleanupStage("delete admission", () => clients[0].doc("admission/active").delete());
        trace?.("admission delete:done");
      } finally {
        trace?.("terminate clients:start");
        await cleanupStage("terminate clients", () =>
          Promise.all(clients.map((client) => client.terminate())),
        );
        trace?.("terminate clients:done");
      }
    },
  };
}

// Absence is the sole skip condition. A configured but unavailable emulator fails these tests.
describe.skipIf(!emulator)("official Firestore emulator", () => {
  storeContract("GcpStore shared contract (two independent clients)", fixture);

  test("Timestamp retention and blob Custom-Time cover Extend without rewriting old children", async () => {
    let time = Date.now();
    const now = () => new Date(time);
    const f = await fixture(now);
    try {
      const record = sessionRecord(now(), {
        ttlSeconds: 60,
        expiresAt: new Date(time + 60_000).toISOString(),
        redeemUntil: new Date(time + 60_000).toISOString(),
      });
      await f.a.createSession(record, {
        clientIp: "192.0.2.1",
        activeMax: 2,
        activePerIp: 1,
        now: now(),
      });
      const ref = f.clients[0].doc(`sessions/${record.id}`);
      const initial = (await ref.get()).data();
      expect(initial?.delete_at).toBeInstanceOf(Timestamp);
      expect(initial?.delete_at.toMillis()).toBe(Date.parse(record.expiresAt) + DAY);
      expect(typeof initial?.incarnation).toBe("string");
      expect(await f.a.getSession(record.id)).not.toHaveProperty("incarnation");
      expect(await f.a.getSession(record.id)).not.toHaveProperty("delete_at");
      const first = await append(f.a, record.id);
      await f.a.putBlob(record.id, "first", new Uint8Array([1]));
      const childBefore = await ref.collection("messages").get();
      expect(childBefore.size).toBe(1);
      expect(childBefore.docs[0].id).toBe(`${initial?.incarnation}_0000000000000001`);
      const childRetention = Date.parse(record.createdAt) + 3_600_000 + DAY;
      expect(childBefore.docs[0].data().delete_at).toBeInstanceOf(Timestamp);
      expect(childBefore.docs[0].data().delete_at.toMillis()).toBe(childRetention);
      time += 30_000;
      const extended = new Date(Date.parse(record.expiresAt) + 1_800_000).toISOString();
      await f.b.updateSession(record.id, (current) => ({
        ...current,
        ttlSeconds: 1860,
        expiresAt: extended,
      }));
      const changed = (await ref.get()).data();
      expect(changed?.incarnation).toBe(initial?.incarnation);
      expect(changed?.delete_at.toMillis()).toBe(Date.parse(extended) + DAY);
      expect(
        (await f.clients[1].doc("admission/active").get()).data()?.leases[record.id].expiresAt,
      ).toBe(extended);
      expect((await childBefore.docs[0].ref.get()).data()).toEqual(childBefore.docs[0].data());
      await append(f.b, record.id, "after extension", first.hash);
      await f.b.putBlob(record.id, "second", new Uint8Array([2]));
      const children = await ref.collection("messages").get();
      expect(children.size).toBe(2);
      for (const child of children.docs)
        expect(child.data().delete_at.toMillis()).toBe(childRetention);
      expect([...f.blobs.objects.values()].map((blob) => blob.customTime)).toEqual([
        new Date(Date.parse(record.createdAt) + 3_600_000).toISOString(),
        new Date(Date.parse(record.createdAt) + 3_600_000).toISOString(),
      ]);
      await f.b.updateSession(record.id, (current) => ({ ...current, state: "stopped" }));
      expect((await f.clients[0].doc("admission/active").get()).data()?.leases).not.toHaveProperty(
        record.id,
      );
    } finally {
      await f.close();
    }
  }, 60_000);

  test("deleting and reusing a parent ID cannot expose previous-incarnation messages or blobs", async () => {
    let time = Date.now();
    const now = () => new Date(time);
    const f = await fixture(now);
    try {
      const record = sessionRecord(now());
      await f.a.createSession(record);
      await append(f.a, record.id, "old ciphertext");
      await f.a.putBlob(record.id, "same", new Uint8Array([1]));
      const ref = f.clients[0].doc(`sessions/${record.id}`);
      const oldIncarnation = (await ref.get()).data()?.incarnation;
      const waiting = f.b.waitForMessage(record.id, 1, 30_000);
      await ref.delete();
      await waiting;
      expect(await f.a.listMessages(record.id, 0, 100)).toEqual([]);
      expect(await f.a.getBlob(record.id, "same")).toBeNull();
      expect((await ref.collection("messages").get()).size).toBe(1);
      time += 2_000;
      await f.b.createSession(sessionRecord(now(), { id: record.id }));
      const newIncarnation = (await ref.get()).data()?.incarnation;
      expect(newIncarnation).not.toBe(oldIncarnation);
      expect(await f.b.listMessages(record.id, 0, 100)).toEqual([]);
      expect(await f.b.getBlob(record.id, "same")).toBeNull();
      const fresh = await append(f.b, record.id, "new ciphertext");
      expect(fresh.seq).toBe(1);
      expect(await f.a.listMessages(record.id, 0, 100)).toEqual([fresh]);
      await f.b.putBlob(record.id, "same", new Uint8Array([2]));
      expect(await f.a.getBlob(record.id, "same")).toEqual(new Uint8Array([2]));
      expect(
        f.blobs.objects.get(`sessions/${record.id}/${oldIncarnation}/blobs/same`)?.bytes,
      ).toEqual(new Uint8Array([1]));
      expect((await ref.collection("messages").get()).size).toBe(2);
    } finally {
      await f.close();
    }
  }, 60_000);

  test("an installed head listener survives Extend past the old expiry and later wakes on stop", async () => {
    const started = Date.now();
    const now = () => new Date();
    const f = await fixture(now);
    try {
      const record = sessionRecord(now(), { expiresAt: new Date(started + 3000).toISOString() });
      await f.a.createSession(record);
      let finished = false;
      const waiting = f.a.waitForMessage(record.id, 0, 20_000).then(() => {
        finished = true;
      });
      await f.b.updateSession(record.id, (current) => ({
        ...current,
        expiresAt: new Date(started + 15_000).toISOString(),
      }));
      await Bun.sleep(Math.max(0, started + 3200 - Date.now()));
      expect(finished).toBe(false);
      await f.b.updateSession(record.id, (current) => ({ ...current, state: "stopped" }));
      await waiting;
      expect(finished).toBe(true);
    } finally {
      await f.close();
    }
  }, 60_000);
});
