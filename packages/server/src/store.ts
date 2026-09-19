// Storage boundary of the dead-drop server. Everything stored here is
// ciphertext or bookkeeping; no store implementation ever sees a key.
import type { Role, SessionState } from "@remote-tab/protocol";

export interface SessionRecord {
  id: string;
  platform: string;
  /** Public key fingerprint and immutable creator identity; never the raw platform key. */
  keyBinding?: { keyHash: string; subject: string };
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  redeemUntil: string;
  ttlSeconds: number;
  agentTokenHash: string;
  browserTokenHash: string | null;
  lastSeq: number;
  lastHash: string;
  clientIp?: string;
  /** Cumulative uploaded/reserved ciphertext bytes, including overwritten blobs. */
  blobBytes?: number;
}

export interface SessionAdmission {
  clientIp: string;
  activePerIp: number;
  activeMax: number;
  now: Date;
}

export interface StoredMessage {
  seq: number;
  role: Role;
  prevHash: string;
  hash: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

export class SessionIdTaken extends Error {
  constructor() {
    super("session id is already in use");
  }
}

export class ChainMismatch extends Error {
  constructor(public readonly expectedPrevHash: string) {
    super("prev_hash does not match the latest stored message");
  }
}

export class SessionNotActive extends Error {
  constructor() {
    super("session is stopped or expired");
  }
}

export class RateLimited extends Error {
  constructor(public readonly retryAfterSeconds = 60) {
    super("rate limit exceeded");
  }
}

export interface Store {
  createSession(record: SessionRecord, admission?: SessionAdmission): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /**
   * Compare-and-swap update. `mutate` receives the current record and returns
   * the new one (or null to abort). Returns the stored record or null when
   * aborted; retries internally on concurrent modification.
   */
  updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null>;
  /** Atomically append to an active chain, preserving concurrent session updates. */
  appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
    messagesMax?: number,
  ): Promise<StoredMessage>;
  listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]>;
  putBlob(
    id: string,
    blobId: string,
    bytes: Uint8Array<ArrayBuffer>,
    budgetBytes?: number,
  ): Promise<void>;
  getBlob(id: string, blobId: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Resolves when a message with seq > afterSeq may exist, or after timeoutMs. */
  waitForMessage(id: string, afterSeq: number, timeoutMs: number): Promise<void>;
}
