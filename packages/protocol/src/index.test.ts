import { describe, expect, test } from "bun:test";
import { CODE_PREFIX, LIMITS, formatCode, parseCode } from "./index";

const id = "6b1f2c3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const secret = "A".repeat(43);

describe("code format", () => {
  test("round-trips", () => {
    expect(parseCode(formatCode(id, secret))).toEqual({ sessionId: id, secret });
  });
  test("rejects malformed session ids, not just wrong lengths", () => {
    const bad = [
      "-".repeat(36), // right length, no hex
      "6b1f2c3a9d4e4f5a8b6c7d8e9f0a1b2c0000", // 36 hex, no separators
      "6b1f2c3a-9d4e-1f5a-8b6c-7d8e9f0a1b2c", // version nibble 1
      "6b1f2c3a-9d4e-4f5a-cb6c-7d8e9f0a1b2c", // variant nibble c
      "6B1F2C3A-9D4E-4F5A-8B6C-7D8E9F0A1B2C", // uppercase
    ];
    for (const sid of bad) expect(parseCode(formatCode(sid, secret))).toBeNull();
  });
  test("there is no link form", () => {
    expect(parseCode(`https://tab.example.test/s/${id}#${secret}`)).toBeNull();
  });
  test("rejects malformed input", () => {
    for (const bad of [
      "",
      "rt1",
      `rt0.${id}.${secret}`,
      `${CODE_PREFIX}.${id}.short`,
      `${CODE_PREFIX}.not-a-uuid.${secret}`,
      `${CODE_PREFIX}.${id}.${secret}.extra`,
      ` ${CODE_PREFIX}.${id}.${"z".repeat(42)}`,
    ]) {
      expect(parseCode(bad)).toBeNull();
    }
  });
});

test("limits match the design table", () => {
  expect(LIMITS.ttlDefaultSeconds).toBe(1800);
  expect(LIMITS.ttlMaxSeconds).toBe(3600);
  expect(LIMITS.redeemWindowSeconds).toBe(600);
});
