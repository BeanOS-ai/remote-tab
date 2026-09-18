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

/** Parse the human-pasted code. Returns null on any malformation. */
export function parseCode(code: string): { sessionId: string; secret: string } | null {
  const trimmed = code.trim();
  const link = trimmed.match(/^https?:\/\/[^/]+\/s\/([0-9a-f-]{36})#([A-Za-z0-9_-]{43})$/);
  if (link) return { sessionId: link[1], secret: link[2] };
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return null;
  const [, sessionId, secret] = parts;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, secret };
}

export function formatCode(sessionId: string, secret: string): string {
  return `${CODE_PREFIX}.${sessionId}.${secret}`;
}
