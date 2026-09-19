import type { Role } from "@remote-tab/protocol";
import {
  ChainMismatch,
  RateLimited,
  type SessionAdmission,
  SessionIdTaken,
  SessionNotActive,
  type SessionRecord,
  type Store,
  type StoredMessage,
} from "./store";

/** In-process store for tests and local development. Single-instance only. */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private messages = new Map<string, StoredMessage[]>();
  private blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  private waiters = new Map<string, Set<() => void>>();

  async createSession(record: SessionRecord, admission?: SessionAdmission): Promise<void> {
    if (this.sessions.has(record.id)) throw new SessionIdTaken();
    if (admission) {
      const live = [...this.sessions.values()].filter(
        (s) =>
          (s.state === "created" || s.state === "active") &&
          Date.parse(s.expiresAt) > admission.now.getTime(),
      );
      if (
        live.length >= admission.activeMax ||
        live.filter((s) => s.clientIp === admission.clientIp).length >= admission.activePerIp
      ) {
        throw new RateLimited();
      }
    }
    this.sessions.set(record.id, { ...record, ...(admission && { clientIp: admission.clientIp }) });
    this.messages.set(record.id, []);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null> {
    const current = this.sessions.get(id);
    if (!current) return null;
    const next = mutate({ ...current });
    if (!next) return null;
    this.sessions.set(id, { ...next });
    this.notify(id);
    return { ...next };
  }

  async appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
    messagesMax = Number.POSITIVE_INFINITY,
  ): Promise<StoredMessage> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("no such session");
    if (session.state !== "active") throw new SessionNotActive();
    if (session.lastSeq >= messagesMax) throw new RateLimited();
    if (input.prevHash !== session.lastHash) throw new ChainMismatch(session.lastHash);
    const seq = session.lastSeq + 1;
    const hash = await hashFor(seq);
    // Hashing yields: another append, stop, or TTL update may have committed.
    // Revalidate and publish synchronously against the latest record.
    const current = this.sessions.get(id);
    if (!current) throw new Error("no such session");
    if (current.state !== "active") throw new SessionNotActive();
    if (current.lastSeq >= messagesMax) throw new RateLimited();
    if (current.lastSeq !== session.lastSeq || current.lastHash !== input.prevHash) {
      throw new ChainMismatch(current.lastHash);
    }
    const stored: StoredMessage = {
      seq,
      role: input.role,
      prevHash: input.prevHash,
      hash,
      nonce: input.nonce,
      ciphertext: input.ciphertext,
      createdAt: new Date().toISOString(),
    };
    this.messages.get(id)?.push(stored);
    this.sessions.set(id, { ...current, lastSeq: seq, lastHash: hash });
    this.notify(id);
    return stored;
  }

  async listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]> {
    return (this.messages.get(id) ?? []).filter((m) => m.seq > afterSeq).slice(0, limit);
  }

  async putBlob(
    id: string,
    blobId: string,
    bytes: Uint8Array<ArrayBuffer>,
    budgetBytes = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state !== "active") throw new SessionNotActive();
    const blobBytes = (session.blobBytes ?? 0) + bytes.byteLength;
    if (blobBytes > budgetBytes) throw new RateLimited();
    this.sessions.set(id, { ...session, blobBytes });
    this.blobs.set(`${id}/${blobId}`, bytes);
  }

  async getBlob(id: string, blobId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.blobs.get(`${id}/${blobId}`) ?? null;
  }

  async waitForMessage(id: string, afterSeq: number, timeoutMs: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.lastSeq > afterSeq) return;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  private notify(id: string): void {
    for (const w of this.waiters.get(id) ?? []) w();
  }
}
