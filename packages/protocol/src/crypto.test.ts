import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  b64url,
  chainHash,
  deriveSessionId,
  deriveSessionKey,
  messageAad,
  open,
  randomSecret,
  seal,
  unb64url,
  verifyChain,
} from "./crypto";
import { type Envelope, PROTOCOL_VERSION } from "./index";

const sid = "0123456789abcdef0123456789abcdef";
const env: Envelope = { v: PROTOCOL_VERSION, kind: "hello", id: "h1", body: { mode: "read" } };

describe("session crypto", () => {
  test("secret requests 16 bytes from the cryptographic RNG and emits canonical base64url", () => {
    const rng = spyOn(crypto, "getRandomValues");
    try {
      const s = randomSecret();
      expect(rng).toHaveBeenCalledTimes(1);
      expect(rng.mock.calls[0][0]?.byteLength).toBe(16);
      expect(s).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
      expect(unb64url(s).byteLength).toBe(16);
      expect(b64url(unb64url(s))).toBe(s);
    } finally {
      rng.mockRestore();
    }
  });

  test("session id is deterministic domain-separated SHA-256, truncated without UUID masking", async () => {
    const raw = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const expected = createHash("sha256")
      .update("remote-tab/v1/session-id")
      .update(raw)
      .digest("hex")
      .slice(0, 32);
    expect(await deriveSessionId(raw.toString("base64url"))).toBe(expected);
    expect(await deriveSessionId(raw.toString("base64url"))).toBe(expected);
    expect(expected).not.toBe(createHash("sha256").update(raw).digest("hex").slice(0, 32));
    for (const invalid of [
      "A".repeat(43),
      "A".repeat(21),
      `${"A".repeat(21)}B`,
      `${raw.toString("base64url")}==`,
    ])
      await expect(deriveSessionId(invalid)).rejects.toThrow("Invalid session secret");
  });

  test("HKDF rejects widths other than the new 16-byte or legacy 32-byte secret", async () => {
    for (const size of [0, 15, 17, 31, 33])
      await expect(deriveSessionKey(b64url(new Uint8Array(size)), sid)).rejects.toThrow(
        "16 or 32 bytes",
      );
  });

  test("seal/open round-trips under the derived key", async () => {
    const secret = randomSecret();
    const a = await deriveSessionKey(secret, sid);
    const b = await deriveSessionKey(secret, sid);
    const aad = messageAad(sid, "browser", "");
    const sealed = await seal(a, env, aad);
    expect(await open(b, sealed, aad)).toEqual(env);
  });

  test("a different session id derives a different key", async () => {
    const secret = randomSecret();
    const a = await deriveSessionKey(secret, sid);
    const other = await deriveSessionKey(secret, "0123456789abcdef0123456789abcde0");
    const aad = messageAad(sid, "browser", "");
    const sealed = await seal(a, env, aad);
    await expect(open(other, sealed, aad)).rejects.toThrow();
  });

  test("tampered AAD (role or chain position) fails to open", async () => {
    const key = await deriveSessionKey(randomSecret(), sid);
    const sealed = await seal(key, env, messageAad(sid, "browser", "abc"));
    await expect(open(key, sealed, messageAad(sid, "agent", "abc"))).rejects.toThrow();
    await expect(open(key, sealed, messageAad(sid, "browser", "def"))).rejects.toThrow();
  });

  test("chain verifies and detects reordering", async () => {
    const msgs = [];
    let prev = "";
    for (let seq = 1; seq <= 3; seq++) {
      const ciphertext = `c${seq}`;
      const hash = await chainHash(sid, seq, ciphertext);
      msgs.push({ seq, prevHash: prev, hash, ciphertext });
      prev = hash;
    }
    expect(await verifyChain(sid, msgs)).toEqual({ ok: true });
    const swapped = [msgs[0], msgs[2], msgs[1]];
    expect((await verifyChain(sid, swapped)).ok).toBe(false);
    const forged = [msgs[0], { ...msgs[1], ciphertext: "evil" }, msgs[2]];
    expect((await verifyChain(sid, forged)).ok).toBe(false);
  });
});
