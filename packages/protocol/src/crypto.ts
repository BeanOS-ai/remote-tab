// End-to-end crypto shared by every installed client (design §5.2).
// Symmetric secret from the pasted code → HKDF-SHA256 → AES-256-GCM.
// The server never runs this file; it only stores what comes out of it.

import { type Envelope, PROTOCOL_VERSION, type Role, SECRET_RE } from "./index";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes backed by a plain ArrayBuffer (what WebCrypto's BufferSource accepts). */
export type Bytes = Uint8Array<ArrayBuffer>;

function bytesOf(text: string): Bytes {
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function encode(text: string): Bytes {
  const encoded = enc.encode(text);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unb64url(text: string): Bytes {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return bytesOf(bin);
}

export function randomSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))));
}

/** Public session locator; hashing the secret never sends the secret to the server. */
export async function deriveSessionId(secret: string): Promise<string> {
  if (typeof secret !== "string" || !SECRET_RE.test(secret))
    throw new Error("Invalid session secret");
  const domain = encode("remote-tab/v1/session-id");
  const input = new Uint8Array(domain.length + 16);
  input.set(domain);
  input.set(unb64url(secret), domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveSessionKey(secret: string, sessionId: string): Promise<CryptoKey> {
  const raw = unb64url(secret);
  if (raw.byteLength !== 16 && raw.byteLength !== 32)
    throw new Error("secret must be 16 or 32 bytes");
  const base = await crypto.subtle.importKey("raw", raw, { name: "HKDF" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encode(`remote-tab/v${PROTOCOL_VERSION}/${sessionId}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Additional authenticated data binds a message to its session, sender role, and chain position. */
export function messageAad(sessionId: string, role: Role, prevHash: string): Bytes {
  return encode(`${sessionId}|${role}|${prevHash}`);
}

export interface SealedMessage {
  nonce: string; // base64url, 12 bytes
  ciphertext: string; // base64url
}

export async function seal(key: CryptoKey, envelope: Envelope, aad: Bytes): Promise<SealedMessage> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const plaintext = encode(JSON.stringify(envelope));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    plaintext,
  );
  return { nonce: b64url(nonce), ciphertext: b64url(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, sealed: SealedMessage, aad: Bytes): Promise<Envelope> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(sealed.nonce), additionalData: aad },
    key,
    unb64url(sealed.ciphertext),
  );
  const parsed = JSON.parse(dec.decode(pt)) as Envelope;
  if (parsed.v !== PROTOCOL_VERSION) throw new Error(`unsupported envelope version ${parsed.v}`);
  return parsed;
}

/** Blob bodies (screenshots, big snapshots) use the same key with an AAD naming the blob's owner. */
export async function sealBytes(
  key: CryptoKey,
  bytes: Bytes,
  aad: Bytes,
): Promise<{ nonce: Bytes; ciphertext: Bytes }> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    bytes,
  );
  return { nonce, ciphertext: new Uint8Array(ct) };
}

export async function openBytes(
  key: CryptoKey,
  nonce: Bytes,
  ciphertext: Bytes,
  aad: Bytes,
): Promise<Bytes> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

/**
 * Chain hash the server computes blind and clients verify: lowercase hex SHA-256 of
 * UTF-8 `${sessionId}|${seq}|${ciphertext}`, with ASCII pipes and decimal seq.
 * ciphertext is the unpadded base64url string including the GCM tag, not decoded bytes.
 */
export async function chainHash(
  sessionId: string,
  seq: number,
  ciphertext: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`${sessionId}|${seq}|${ciphertext}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a stored sequence forms one unbroken chain from the genesis "" prev_hash. */
export async function verifyChain(
  sessionId: string,
  messages: ReadonlyArray<{ seq: number; prevHash: string; hash: string; ciphertext: string }>,
): Promise<{ ok: true } | { ok: false; seq: number; reason: string }> {
  let expectedPrev = "";
  let expectedSeq = 1;
  for (const m of messages) {
    if (m.seq !== expectedSeq)
      return { ok: false, seq: m.seq, reason: `gap: expected seq ${expectedSeq}` };
    if (m.prevHash !== expectedPrev) return { ok: false, seq: m.seq, reason: "prev_hash mismatch" };
    const h = await chainHash(sessionId, m.seq, m.ciphertext);
    if (h !== m.hash) return { ok: false, seq: m.seq, reason: "hash mismatch" };
    expectedPrev = h;
    expectedSeq += 1;
  }
  return { ok: true };
}
