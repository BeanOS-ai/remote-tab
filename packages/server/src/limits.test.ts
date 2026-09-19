import { expect, test } from "bun:test";
import { DEFAULT_THROTTLES, clientIp, parseThrottleEnv, parseTrustedProxyHops } from "./limits";
const req = (xff?: string) =>
  new Request("https://server.test/", {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });

test("trusted hop count selects from the right and prevents spoofed first-address quotas", () => {
  const request = req("192.0.2.99, 198.51.100.7, 10.0.0.2");
  expect(clientIp(request, "10.0.0.1", false, 0)).toBe("10.0.0.1");
  expect(clientIp(request, "10.0.0.1", false, 1)).toBe("10.0.0.2");
  expect(clientIp(request, "10.0.0.1", false, 2)).toBe("198.51.100.7");
  expect(clientIp(req("203.0.113.99, 198.51.100.7, 10.0.0.2"), "10.0.0.1", true, 2)).toBe(
    "198.51.100.7",
  );
  expect(clientIp(request, "10.0.0.1", true, 0)).toBe("10.0.0.1");
  expect(clientIp(request, "10.0.0.1", true)).toBe("192.0.2.99");
  expect(clientIp(request, "10.0.0.1", false)).toBe("10.0.0.1");
});

test("invalid or short chains fail back to the socket, never the attacker-selected prefix", () => {
  for (const xff of [
    undefined,
    "",
    "198.51.100.1",
    "garbage, 10.0.0.2",
    "198.51.100.1,",
    "198.51.100.1:80, 10.0.0.2",
    "fe80::1%eth0, 10.0.0.2",
  ])
    expect(clientIp(req(xff), "10.0.0.1", true, 2)).toBe("10.0.0.1");
  for (const hops of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(clientIp(req("198.51.100.1"), "10.0.0.1", true, hops)).toBe("10.0.0.1");
  expect(clientIp(req("198.51.100.1"), undefined, true, 1)).toBe("unknown");
  expect(clientIp(req("198.51.100.1"), "invalid", true, 1)).toBe("unknown");
});

test("trusted chains preserve IPv6 canonicalization and IPv4-mapped identity equivalence", () => {
  expect(clientIp(req("::ffff:192.0.2.1, 10.0.0.2"), "10.0.0.1", false, 2)).toBe("192.0.2.1");
  expect(clientIp(req("::ffff:c000:201"), "10.0.0.1", false, 1)).toBe("192.0.2.1");
  expect(clientIp(req("2001:0db8:0000:0000:0000:0000:0000:0001"), "10.0.0.1", false, 1)).toBe(
    "2001:db8::1",
  );
  expect(clientIp(req(), "::ffff:192.0.2.1", false)).toBe("192.0.2.1");
});

test("proxy-hop configuration allows zero and rejects invalid startup values without echoing them", () => {
  expect(parseTrustedProxyHops({})).toBeUndefined();
  expect(parseTrustedProxyHops({ REMOTE_TAB_TRUST_PROXY_HOPS: " " })).toBeUndefined();
  for (const n of [0, 1, 2, 100])
    expect(parseTrustedProxyHops({ REMOTE_TAB_TRUST_PROXY_HOPS: String(n) })).toBe(n);
  for (const raw of [
    "-1",
    "1.1",
    "Infinity",
    "invalid-secret",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])
    expect(() => parseTrustedProxyHops({ REMOTE_TAB_TRUST_PROXY_HOPS: raw })).toThrow(
      "must be a nonnegative safe integer",
    );
});

test("resource backstops remain positive integers and the retired create-rate env has no effect", () => {
  expect(parseThrottleEnv({ REMOTE_TAB_CREATE_PER_MINUTE: "1" })).toEqual(DEFAULT_THROTTLES);
  expect("createPerMinute" in DEFAULT_THROTTLES).toBe(false);
  for (const [name, field] of [
    ["REMOTE_TAB_ACTIVE_PER_IP", "activePerIp"],
    ["REMOTE_TAB_ACTIVE_MAX", "activeMax"],
    ["REMOTE_TAB_BLOB_BUDGET_BYTES", "blobBudgetBytes"],
    ["REMOTE_TAB_MESSAGES_MAX", "messagesMax"],
  ] as const) {
    expect(parseThrottleEnv({ [name]: "1" })[field]).toBe(1);
    for (const value of ["0", "-1", "0.5", "Infinity", "invalid"])
      expect(() => parseThrottleEnv({ [name]: value })).toThrow("must be a positive safe integer");
  }
});
