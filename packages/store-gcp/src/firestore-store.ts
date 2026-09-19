import { FieldPath, type Firestore, Timestamp } from "@google-cloud/firestore";
import { LIMITS, type Role, SESSION_ID_RE } from "@remote-tab/protocol";
import {
  ChainMismatch,
  RateLimited,
  type SessionAdmission,
  SessionIdTaken,
  SessionNotActive,
  type SessionRecord,
  type Store,
  type StoredMessage,
} from "@remote-tab/server/store";
import type { BlobStore } from "./blob-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LEASES = 1000;
interface SessionDocument extends SessionRecord {
  incarnation: string;
  delete_at: Timestamp;
}
interface Lease {
  clientIp: string;
  expiresAt: string;
}
type Leases = Record<string, Lease>;

export interface GcpStoreOptions {
  firestore: Firestore;
  blobs: BlobStore;
  now?: () => Date;
}

export function validateGcpActiveMax(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASES)
    throw new Error("GCP active session limit must be an integer between 1 and 1000");
}

function publicRecord(document: SessionDocument): SessionRecord {
  const { incarnation: _incarnation, delete_at: _deleteAt, ...record } = document;
  return record;
}

function expiry(record: SessionRecord): number {
  const value = Date.parse(record.expiresAt);
  if (!Number.isFinite(value)) throw new Error("Invalid session expiry");
  return value;
}

function sequenceId(incarnation: string, seq: number): string {
  return `${incarnation}_${String(seq).padStart(16, "0")}`;
}

/** Firestore owns the commit points; GCS only receives immutable ciphertext. */
export class GcpStore implements Store {
  readonly firestore: Firestore;
  private readonly blobs: BlobStore;
  private readonly now: () => Date;

  constructor(options: GcpStoreOptions) {
    this.firestore = options.firestore;
    this.blobs = options.blobs;
    this.now = options.now ?? (() => new Date());
  }

  private session(id: string) {
    if (!SESSION_ID_RE.test(id)) throw new Error("Invalid session ID");
    return this.firestore.collection("sessions").doc(id);
  }

  private active(record: SessionRecord): void {
    if (record.state !== "active" || expiry(record) <= this.now().getTime())
      throw new SessionNotActive();
  }

  private retention(record: SessionRecord): Date {
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created)) throw new Error("Invalid session creation time");
    return new Date(created + LIMITS.ttlMaxSeconds * 1000);
  }

  async createSession(record: SessionRecord, admission?: SessionAdmission): Promise<void> {
    const ref = this.session(record.id);
    if (admission) {
      validateGcpActiveMax(admission.activeMax);
      if (
        !Number.isSafeInteger(admission.activePerIp) ||
        admission.activePerIp < 1 ||
        !admission.clientIp ||
        admission.clientIp.length > 64
      )
        throw new Error("Invalid session admission policy");
    }
    const document: SessionDocument = {
      ...record,
      ...(admission && { clientIp: admission.clientIp }),
      incarnation: crypto.randomUUID().replaceAll("-", ""),
      delete_at: Timestamp.fromMillis(expiry(record) + DAY_MS),
    };
    const admissionRef = this.firestore.doc("admission/active");
    await this.firestore.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) throw new SessionIdTaken();
      if (admission) {
        const snapshot = await tx.get(admissionRef);
        const current = (snapshot.data()?.leases ?? {}) as Leases;
        const now = this.now().getTime();
        const live = Object.fromEntries(
          Object.entries(current).filter(([, lease]) => Date.parse(lease.expiresAt) > now),
        );
        const leases = Object.values(live);
        if (
          leases.length >= admission.activeMax ||
          leases.filter((lease) => lease.clientIp === admission.clientIp).length >=
            admission.activePerIp
        )
          throw new RateLimited();
        if (Object.hasOwn(live, record.id)) throw new SessionIdTaken();
        live[record.id] = { clientIp: admission.clientIp, expiresAt: record.expiresAt };
        tx.set(admissionRef, { leases: live });
      }
      tx.create(ref, document);
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const snapshot = await this.session(id).get();
    return snapshot.exists ? publicRecord(snapshot.data() as SessionDocument) : null;
  }

  async updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null> {
    const ref = this.session(id);
    const admissionRef = this.firestore.doc("admission/active");
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const current = snapshot.data() as SessionDocument;
      const next = mutate(publicRecord(current));
      if (!next) return null;
      if (
        (current.state === "stopped" ||
          current.state === "expired" ||
          expiry(current) <= this.now().getTime()) &&
        (next.state === "active" || next.state === "created")
      )
        return null;
      if (next.id !== id || next.createdAt !== current.createdAt)
        throw new Error("Session identity and creation time are immutable");
      const extending = expiry(next) > expiry(current);
      if (extending) this.active(current);
      if (current.clientIp && (extending || next.state === "stopped" || next.state === "expired")) {
        const admissionSnapshot = await tx.get(admissionRef);
        if (extending) this.active(current);
        const leases = (admissionSnapshot.data()?.leases ?? {}) as Leases;
        if (extending) {
          if (!Object.hasOwn(leases, id)) return null;
          leases[id] = { clientIp: current.clientIp, expiresAt: next.expiresAt };
        } else {
          delete leases[id];
        }
        tx.set(admissionRef, { leases });
      }
      tx.set(ref, {
        ...next,
        incarnation: current.incarnation,
        delete_at: Timestamp.fromMillis(expiry(next) + DAY_MS),
      });
      return next;
    });
  }

  async appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
    messagesMax = Number.POSITIVE_INFINITY,
  ): Promise<StoredMessage> {
    const ref = this.session(id);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new SessionNotActive();
      const current = snapshot.data() as SessionDocument;
      this.active(current);
      if (current.lastSeq >= messagesMax) throw new RateLimited();
      if (input.prevHash !== current.lastHash) throw new ChainMismatch(current.lastHash);
      const seq = current.lastSeq + 1;
      if (!Number.isSafeInteger(seq)) throw new RateLimited();
      const hash = await hashFor(seq);
      this.active(current);
      const message: StoredMessage = {
        ...input,
        seq,
        hash,
        createdAt: this.now().toISOString(),
      };
      tx.create(ref.collection("messages").doc(sequenceId(current.incarnation, seq)), {
        ...message,
        delete_at: Timestamp.fromMillis(this.retention(current).getTime() + DAY_MS),
      });
      tx.update(ref, { lastSeq: seq, lastHash: hash });
      return message;
    });
  }

  async listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]> {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    )
      throw new Error("Invalid message page");
    if (limit === 0) return [];
    const ref = this.session(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return [];
    const current = snapshot.data() as SessionDocument;
    if (afterSeq >= current.lastSeq) return [];
    const messages = await ref
      .collection("messages")
      .orderBy(FieldPath.documentId())
      .startAfter(sequenceId(current.incarnation, afterSeq))
      .endAt(sequenceId(current.incarnation, current.lastSeq))
      .limit(limit)
      .get();
    return messages.docs.map((doc) => {
      const { delete_at: _deleteAt, ...message } = doc.data();
      return message as StoredMessage;
    });
  }

  async putBlob(
    id: string,
    blobId: string,
    bytes: Uint8Array<ArrayBuffer>,
    budgetBytes = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const ref = this.session(id);
    const reserved = await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new SessionNotActive();
      const current = snapshot.data() as SessionDocument;
      this.active(current);
      const blobBytes = (current.blobBytes ?? 0) + bytes.byteLength;
      if (!Number.isSafeInteger(blobBytes) || blobBytes > budgetBytes) throw new RateLimited();
      tx.update(ref, { blobBytes });
      return current;
    });
    await this.blobs.put(
      `sessions/${id}/${reserved.incarnation}/blobs/${blobId}`,
      bytes,
      this.retention(reserved),
    );
  }

  async getBlob(id: string, blobId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const snapshot = await this.session(id).get();
    if (!snapshot.exists) return null;
    const current = snapshot.data() as SessionDocument;
    return this.blobs.get(`sessions/${id}/${current.incarnation}/blobs/${blobId}`);
  }

  async waitForMessage(
    id: string,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted) return;
    const ref = this.session(id);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish();
      const timeout = setTimeout(() => finish(), Math.min(timeoutMs, 25_000));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(expiryTimer);
        signal?.removeEventListener("abort", onAbort);
        unsubscribe?.();
        if (error) reject(error);
        else resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return finish();
      try {
        unsubscribe = ref.onSnapshot(
          (snapshot) => {
            if (settled) return;
            if (!snapshot.exists) return finish();
            const current = snapshot.data() as SessionDocument;
            const remaining = expiry(current) - this.now().getTime();
            if (
              current.lastSeq > afterSeq ||
              current.state === "stopped" ||
              current.state === "expired" ||
              remaining <= 0
            )
              return finish();
            clearTimeout(expiryTimer);
            expiryTimer = setTimeout(() => finish(), Math.min(remaining, 2_147_483_647));
          },
          (error) => finish(error),
        );
        // Also handles an injected listener that invokes its initial callback synchronously.
        if (settled) unsubscribe();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Firestore listener failed"));
      }
    });
  }
}
