import { describe, expect, test } from "bun:test";
import {
  chainHash,
  deriveSessionKey,
  messageAad,
  open,
  randomSecret,
  seal,
  unb64url,
  verifyChain,
} from "./crypto";
import { type Envelope, PROTOCOL_VERSION } from "./index";

const sid = "6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const env: Envelope = { v: PROTOCOL_VERSION, kind: "hello", id: "h1", body: { mode: "read" } };

describe("session crypto", () => {
  test("secret is 32 random bytes base64url", () => {
    const s = randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(unb64url(s).byteLength).toBe(32);
    expect(randomSecret()).not.toBe(s);
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
    const other = await deriveSessionKey(secret, "6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2d");
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
