import { expect, test } from "bun:test";
import { createCipheriv, hkdfSync } from "node:crypto";
import vector from "../../../docs/crypto-vector.json";
import { chainHash, deriveSessionKey, messageAad, open, unb64url } from "./crypto";

test("documented fixed vector matches independent HKDF/GCM, WebCrypto open, and chain hash", async () => {
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
