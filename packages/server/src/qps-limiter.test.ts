import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { QpsLimiter } from "./qps-limiter";
import { RateLimited } from "./store";
afterEach(() => setSystemTime());
describe("QpsLimiter", () => {
  test("concurrent consumption, independent subject/IP identities and retry seconds", async () => {
    setSystemTime(100000);
    const limiter = new QpsLimiter();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => limiter.consume("subject:a", 2)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const denied = results.find((r) => r.status === "rejected");
    if (denied?.status === "rejected") {
      expect(denied.reason).toBeInstanceOf(RateLimited);
      expect(denied.reason.retryAfterSeconds).toBe(1);
    }
    await limiter.consume("subject:b", 1);
    await limiter.consume("ip:a", 1);
    setSystemTime(101001);
    await limiter.consume("subject:a", 2);
  });
  test("rate changes and unlimited transitions do not reset a live counter", async () => {
    setSystemTime(200000);
    const limiter = new QpsLimiter();
    await limiter.consume("a", 1);
    await limiter.consume("a", 2);
    await expect(limiter.consume("a", 1)).rejects.toBeInstanceOf(RateLimited);
    await limiter.consume("a", 0);
    await expect(limiter.consume("a", 2)).rejects.toBeInstanceOf(RateLimited);
    await limiter.consume("a", 5);
    await expect(limiter.consume("a", 5)).rejects.toBeInstanceOf(RateLimited);
  });
  test("unlimited bypass, integer validation and bounded identities without live eviction", async () => {
    setSystemTime(300000);
    const limiter = new QpsLimiter({ maxIdentities: 1 });
    await limiter.consume("unlimited", 0);
    await limiter.consume("a", 1);
    await expect(limiter.consume("b", 1)).rejects.toBeInstanceOf(RateLimited);
    await expect(limiter.consume("a", 1)).rejects.toBeInstanceOf(RateLimited);
    setSystemTime(301001);
    await limiter.consume("b", 1);
    for (const qps of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      await expect(limiter.consume("x", qps)).rejects.toThrow("invalid QPS");
  });
  test("clock rollback cannot evict a live window", async () => {
    setSystemTime(400000);
    const limiter = new QpsLimiter({ maxIdentities: 1 });
    await limiter.consume("a", 1);
    setSystemTime(399000);
    await expect(limiter.consume("b", 1)).rejects.toBeInstanceOf(RateLimited);
    await expect(limiter.consume("a", 1)).rejects.toBeInstanceOf(RateLimited);
  });
});
