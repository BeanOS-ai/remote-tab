// Protocol constants and shapes shared by server, client, and extension.
// See docs/design.md §4–§6. Keep this file dependency-free.

export const PROTOCOL_VERSION = 1;
export const CODE_PREFIX = "rt1";

export const LIMITS = {
  ttlDefaultSeconds: 30 * 60,
  ttlMaxSeconds: 60 * 60,
  redeemWindowSeconds: 10 * 60,
  messageMaxBytes: 64 * 1024,
  blobMaxBytes: 4 * 1024 * 1024,
  longPollMaxSeconds: 25,
} as const;

export type Role = "agent" | "browser";
export type Mode = "read" | "act" | "full";
export type SessionState = "created" | "redeemed" | "active" | "stopped" | "expired";

/** What the server stores per message: ciphertext plus chain metadata. Never plaintext. */
export interface StoredMessage {
  seq: number;
  role: Role;
  prevHash: string; // hex SHA-256 of the previous stored message, "" for seq 1
  hash: string; // hex SHA-256(sessionId || seq || ciphertext)
  nonce: string; // base64url, 12 bytes
  ciphertext: string; // base64url
  createdAt: string; // ISO-8601
}

/** Plaintext envelope inside every ciphertext. */
export interface Envelope {
  v: typeof PROTOCOL_VERSION;
  kind: "hello" | "command" | "result" | "handoff" | "handoff_done" | "stop";
  id: string; // correlation id for command/result
  body: unknown;
}

/** Lowercase RFC 4122 v4 UUID: 8-4-4-4-12 hex groups, version nibble 4, variant 8..b. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 32 random bytes, base64url without padding. */
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parse the human-pasted code `rt1.<session-id>.<secret>`. Returns null on any
 * malformation so callers can reject before attempting a redeem. There is
 * deliberately no link form: a link would hand the secret to a web page, and
 * only installed clients may hold it (design §5.5).
 */
export function parseCode(code: string): { sessionId: string; secret: string } | null {
  const parts = code.trim().split(".");
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return null;
  const [, sessionId, secret] = parts;
  if (!UUID_V4_RE.test(sessionId)) return null;
  if (!SECRET_RE.test(secret)) return null;
  return { sessionId, secret };
}

export function formatCode(sessionId: string, secret: string): string {
  return `${CODE_PREFIX}.${sessionId}.${secret}`;
}

/** Wire shapes of the dead-drop API (design §5.3). */
export interface CreateSessionRequest {
  ttl_seconds?: number;
}
export interface CreateSessionResponse {
  id: string;
  agent_token: string;
  expires_at: string;
  redeem_until: string;
}
export interface RedeemResponse {
  browser_token: string;
  expires_at: string;
}
export interface AppendMessageRequest {
  role: Role;
  prev_hash: string;
  nonce: string;
  ciphertext: string;
}
export interface AppendMessageResponse {
  seq: number;
  hash: string;
}
export interface WireMessage {
  seq: number;
  role: Role;
  prev_hash: string;
  hash: string;
  nonce: string;
  ciphertext: string;
  created_at: string;
}
export interface SessionStatus {
  id: string;
  state: SessionState;
  expires_at: string;
  last_seq: number;
  last_hash: string;
  redeemed: boolean;
}
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "already_redeemed"
  | "redeem_window_closed"
  | "session_not_active"
  | "chain_mismatch"
  | "rate_limited"
  | "too_large"
  | "ttl_exceeded"
  | "invalid";
export interface ErrorResponse {
  error: ErrorCode;
  message: string;
}
