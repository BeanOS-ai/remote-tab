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
  constructor(private readonly now: () => Date = () => new Date()) {}

  private live(session: SessionRecord): boolean {
    return (
      (session.state === "created" || session.state === "active") &&
      Date.parse(session.expiresAt) > this.now().getTime()
    );
  }
  private active(session: SessionRecord): boolean {
    return session.state === "active" && this.live(session);
  }

  async createSession(record: SessionRecord, admission?: SessionAdmission): Promise<void> {
    if (this.sessions.has(record.id)) throw new SessionIdTaken();
    if (admission) {
      const live = [...this.sessions.values()].filter(
        (s) =>
          (s.state === "created" || s.state === "active") &&
          Date.parse(s.expiresAt) > this.now().getTime(),
      );
      if (
        live.length >= admission.activeMax ||
        live.filter((s) => s.clientIp === admission.clientIp).length >= admission.activePerIp
      ) {
        throw new RateLimited();
      }
    }
    this.sessions.set(
      record.id,
      structuredClone({ ...record, ...(admission && { clientIp: admission.clientIp }) }),
    );
    this.messages.set(record.id, []);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null> {
    const current = this.sessions.get(id);
    if (!current) return null;
    const next = mutate(structuredClone(current));
    if (!next) return null;
    if (next.id !== id || next.createdAt !== current.createdAt)
      throw new Error("Session identity and creation time are immutable");
    if (
      (next.state === "active" || next.state === "created") &&
      (current.state === "stopped" ||
        current.state === "expired" ||
        Date.parse(current.expiresAt) <= this.now().getTime())
    )
      return null;
    this.sessions.set(id, structuredClone(next));
    this.notify(id);
    return structuredClone(next);
  }

  async appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
    messagesMax = Number.POSITIVE_INFINITY,
  ): Promise<StoredMessage> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotActive();
    if (!this.active(session)) throw new SessionNotActive();
    if (session.lastSeq >= messagesMax) throw new RateLimited();
    if (input.prevHash !== session.lastHash) throw new ChainMismatch(session.lastHash);
    const seq = session.lastSeq + 1;
    const hash = await hashFor(seq);
    // Hashing yields: another append, stop, or TTL update may have committed.
    // Revalidate and publish synchronously against the latest record.
    const current = this.sessions.get(id);
    if (!current) throw new SessionNotActive();
    if (!this.active(current)) throw new SessionNotActive();
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
      createdAt: this.now().toISOString(),
    };
    this.messages.get(id)?.push(stored);
    this.sessions.set(id, { ...current, lastSeq: seq, lastHash: hash });
    this.notify(id);
    return { ...stored };
  }

  async listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]> {
    return (this.messages.get(id) ?? [])
      .filter((m) => m.seq > afterSeq)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  async putBlob(
    id: string,
    blobId: string,
    bytes: Uint8Array<ArrayBuffer>,
    budgetBytes = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !this.active(session)) throw new SessionNotActive();
    const blobBytes = (session.blobBytes ?? 0) + bytes.byteLength;
    if (!Number.isSafeInteger(blobBytes) || blobBytes > budgetBytes) throw new RateLimited();
    this.sessions.set(id, { ...session, blobBytes });
    const key = `${id}/${blobId}`;
    if (this.blobs.has(key)) throw new Error("blob already exists");
    this.blobs.set(key, new Uint8Array(bytes));
  }

  async getBlob(id: string, blobId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const bytes = this.blobs.get(`${id}/${blobId}`);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async waitForMessage(
    id: string,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted) return;
    const session = this.sessions.get(id);
    if (!session || session.lastSeq > afterSeq || !this.live(session)) return;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      let expiryTimer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(expiryTimer);
        set.delete(check);
        if (set.size === 0) this.waiters.delete(id);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const check = () => {
        clearTimeout(expiryTimer);
        const current = this.sessions.get(id);
        if (!current || current.lastSeq > afterSeq || !this.live(current)) return done();
        expiryTimer = setTimeout(
          check,
          Math.max(1, Date.parse(current.expiresAt) - this.now().getTime()),
        );
      };
      const timer = setTimeout(done, Math.min(timeoutMs, 25_000));
      set.add(check);
      this.waiters.set(id, set);
      signal?.addEventListener("abort", done, { once: true });
      check();
    });
  }

  private notify(id: string): void {
    for (const w of this.waiters.get(id) ?? []) w();
  }
}
