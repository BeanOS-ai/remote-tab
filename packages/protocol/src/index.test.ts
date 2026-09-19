import { describe, expect, test } from "bun:test";
import { CODE_PREFIX, LIMITS, SESSION_ID_RE, UUID_V4_RE, formatCode, parseCode } from "./index";

const secret = "AAECAwQFBgcICQoLDA0ODw";
const oldId = "6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

describe("code format", () => {
  test("round-trips a 26-character code synchronously, tolerating pasted outer whitespace", () => {
    const code = formatCode(secret);
    expect(code).toBe(`rt1.${secret}`);
    expect(code.length).toBe(26);
    expect(parseCode(code)).toEqual({ secret });
    expect(parseCode(` \n${code}\t`)).toEqual({ secret });
  });
  test("accepts only canonical unused bits in the last base64url character", () => {
    for (const last of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
      const candidate = `${"A".repeat(21)}${last}`;
      if ("AQgw".includes(last)) {
        expect(parseCode(`${CODE_PREFIX}.${candidate}`)).toEqual({ secret: candidate });
        expect(formatCode(candidate)).toBe(`${CODE_PREFIX}.${candidate}`);
      } else {
        expect(parseCode(`${CODE_PREFIX}.${candidate}`)).toBeNull();
        expect(() => formatCode(candidate)).toThrow("Invalid session secret");
      }
    }
  });
  test("rejects legacy codes, link forms and malformed input", () => {
    for (const bad of [
      "",
      "rt1",
      `rt0.${secret}`,
      `${CODE_PREFIX}.short`,
      `${CODE_PREFIX}.${oldId}.${secret}`,
      `${CODE_PREFIX}.${oldId}.${"A".repeat(43)}`,
      `${CODE_PREFIX}.${"A".repeat(43)}`,
      `${CODE_PREFIX}.${secret}.extra`,
      `${CODE_PREFIX}.${secret}=`,
      `${CODE_PREFIX}.${secret}==`,
      `${CODE_PREFIX}.${secret.slice(0, 8)} ${secret.slice(8)}`,
      `${CODE_PREFIX}.${"/".repeat(21)}A`,
      `${CODE_PREFIX}.${"+".repeat(21)}A`,
      `https://tab.example.test/s/${oldId}#${secret}`,
    ])
      expect(parseCode(bad)).toBeNull();
    for (const malformed of [
      "",
      "A".repeat(21),
      "A".repeat(23),
      "A".repeat(43),
      `${secret}=`,
      `${secret}\n`,
    ])
      expect(() => formatCode(malformed)).toThrow("Invalid session secret");
  });
});

test("session locators are lowercase 32-hex while non-session UUID validation stays available", () => {
  expect(SESSION_ID_RE.test("0123456789abcdef0123456789abcdef")).toBe(true);
  for (const bad of [oldId, "A".repeat(32), "g".repeat(32), "0".repeat(31), "0".repeat(33)])
    expect(SESSION_ID_RE.test(bad)).toBe(false);
  expect(UUID_V4_RE.test(oldId)).toBe(true);
});

test("limits match the design table", () => {
  expect(LIMITS.ttlDefaultSeconds).toBe(1800);
  expect(LIMITS.ttlMaxSeconds).toBe(3600);
  expect(LIMITS.redeemWindowSeconds).toBe(600);
});
