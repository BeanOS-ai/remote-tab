import { describe, expect, test } from "bun:test";
import { CODE_PREFIX, LIMITS, formatCode, parseCode } from "./index";

const id = "6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const secret = "A".repeat(43);

describe("code format", () => {
  test("round-trips", () => {
    expect(parseCode(formatCode(id, secret))).toEqual({ sessionId: id, secret });
  });
  test("accepts the link form with the secret in the fragment", () => {
    expect(parseCode(`https://tab.example.test/s/${id}#${secret}`)).toEqual({
      sessionId: id,
      secret,
    });
  });
  test("rejects malformed input", () => {
    for (const bad of [
      "",
      "rt1",
      `rt0.${id}.${secret}`,
      `${CODE_PREFIX}.${id}.short`,
      `${CODE_PREFIX}.not-a-uuid.${secret}`,
      `https://x/s/${id}`,
    ]) {
      expect(parseCode(bad)).toBeNull();
    }
  });
  test("secret never appears before the fragment in the link form", () => {
    const link = `https://tab.example.test/s/${id}#${secret}`;
    expect(new URL(link).pathname).not.toContain(secret);
  });
});

test("limits match the design table", () => {
  expect(LIMITS.ttlDefaultSeconds).toBe(1800);
  expect(LIMITS.ttlMaxSeconds).toBe(3600);
  expect(LIMITS.redeemWindowSeconds).toBe(600);
});
