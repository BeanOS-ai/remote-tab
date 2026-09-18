import { describe, expect, test } from "bun:test";
import { isWithinScope, siteForUrl } from "./scope";

describe("PSL site scope", () => {
  test.each([
    ["https://a.shop.example.co.uk/path", "example.co.uk"],
    ["https://x.school.k12.ak.us", "school.k12.ak.us"],
    ["https://user.github.io", "user.github.io"],
    ["https://a.b.ck", "a.b.ck"],
    ["https://x.www.ck", "www.ck"],
    ["https://x.city.kawasaki.jp", "city.kawasaki.jp"],
    ["https://a.b.kawasaki.jp", "a.b.kawasaki.jp"],
    ["https://www.食狮.com.cn", "xn--85x722f.com.cn"],
    ["https://127.0.0.1:8443", "127.0.0.1"],
    ["http://[::1]:8080", "[::1]"],
    ["http://localhost:3000", "localhost"],
    ["https://EXAMPLE.COM.", "example.com"],
  ])("%s resolves to %s", (url, expected) => expect(siteForUrl(url)).toBe(expected));
  test("allows siblings but isolates private suffix tenants and public suffixes", () => {
    expect(isWithinScope("https://mail.example.co.uk", "example.co.uk")).toBe(true);
    expect(isWithinScope("https://other.co.uk", "example.co.uk")).toBe(false);
    expect(isWithinScope("https://evil.github.io", "good.github.io")).toBe(false);
    expect(isWithinScope("https://x.foo.ck", "foo.ck")).toBe(false);
    expect(isWithinScope("https://evil.example.com.attacker.net", "example.com")).toBe(false);
  });
  test("unrestricted means HTTP(S), never browser internals or credentials", () => {
    expect(isWithinScope("https://anywhere.example", null)).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:pass@example.com",
      "invalid",
    ])
      expect(isWithinScope(url, null)).toBe(false);
  });
});
