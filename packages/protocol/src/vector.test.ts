import { expect, test } from "bun:test";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import vector from "../../../docs/crypto-vector.json";
import { chainHash, deriveSessionId, deriveSessionKey, messageAad, open, unb64url } from "./crypto";

test("documented fixed vector matches independent HKDF/GCM, WebCrypto open, and chain hash", async () => {
  expect(unb64url(vector.secret).length).toBe(16);
  const sessionHash = createHash("sha256")
    .update("remote-tab/v1/session-id")
    .update(Buffer.from(vector.secret, "base64url"))
    .digest("hex");
  expect(sessionHash).toBe(vector.session_id_sha256);
  expect(sessionHash.slice(0, 32)).toBe(vector.session_id);
  expect(await deriveSessionId(vector.secret)).toBe(vector.session_id);
  const keyBytes = Buffer.from(
    hkdfSync(
      "sha256",
      unb64url(vector.secret),
      Buffer.alloc(0),
      `remote-tab/v1/${vector.session_id}`,
      32,
    ),
  );
  expect(keyBytes.toString("hex")).toBe(vector.key_hex);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, unb64url(vector.nonce));
  cipher.setAAD(Buffer.from(vector.aad));
  const bytes = Buffer.concat([
    cipher.update(vector.plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  expect(bytes.toString("base64url")).toBe(vector.ciphertext);
  const aad = messageAad(vector.session_id, "browser", vector.prev_hash);
  expect(new TextDecoder().decode(aad)).toBe(vector.aad);
  const key = await deriveSessionKey(vector.secret, vector.session_id);
  expect(await open(key, vector, aad)).toEqual(JSON.parse(vector.plaintext));
  expect(await chainHash(vector.session_id, vector.seq, vector.ciphertext)).toBe(vector.hash);
});

test("the legacy 32-byte HKDF/GCM vector still decrypts without accepting legacy codes", async () => {
  const old = {
    session_id: "00000000-0000-4000-8000-000000000001",
    secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    key_hex: "0415dd200092a439d3defa66fce6bc5a282c4ee6dc56fece05f0580543ba54d4",
    nonce: "AAECAwQFBgcICQoL",
    ciphertext:
      "yK0dfo-I_8BO3e4DENdT7hSZ-Z2-QuGOU-jL1zkIhD01wzEfpEWvtbIelI914yHd-0LZ9Wdz_MkDxUqzyukTQiG1Yx19kXrLqOX0",
  };
  const expectedKey = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(old.secret, "base64url"),
      Buffer.alloc(0),
      `remote-tab/v1/${old.session_id}`,
      32,
    ),
  );
  expect(expectedKey.toString("hex")).toBe(old.key_hex);
  const key = await deriveSessionKey(old.secret, old.session_id);
  expect(await open(key, old, messageAad(old.session_id, "browser", ""))).toEqual(
    JSON.parse(vector.plaintext),
  );
});
