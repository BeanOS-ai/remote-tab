import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { RateLimited } from "./store";

/** Per-identity, one-second windows; changing a quota never resets its counter. */
export class QpsLimiter {
  private readonly entries = new Map<string, { limiter: RateLimiterMemory; touched: number }>();
  private readonly maxIdentities: number;
  constructor(options: { maxIdentities?: number } = {}) {
    this.maxIdentities = options.maxIdentities ?? 10000;
    if (!Number.isSafeInteger(this.maxIdentities) || this.maxIdentities < 1)
      throw new Error("invalid limiter capacity");
  }
  async consume(identity: string, qps: number): Promise<void> {
    if (!Number.isSafeInteger(qps) || qps < 0) throw new Error("invalid QPS");
    if (qps === 0) return;
    const now = Date.now();
    // Map order is last-use order. Only idle, expired windows may be removed.
    for (const [key, entry] of this.entries) {
      if (now - entry.touched < 1000) break;
      void entry.limiter.delete(key);
      this.entries.delete(key);
    }
    let entry = this.entries.get(identity);
    if (!entry) {
      if (this.entries.size >= this.maxIdentities) throw new RateLimited(1);
      entry = { limiter: new RateLimiterMemory({ points: qps, duration: 1 }), touched: now };
    }
    entry.limiter.points = qps;
    entry.touched = Math.max(now, entry.touched);
    this.entries.delete(identity);
    this.entries.set(identity, entry);
    try {
      await entry.limiter.consume(identity);
    } catch (error) {
      if (error instanceof RateLimiterRes)
        throw new RateLimited(Math.max(1, Math.ceil(error.msBeforeNext / 1000)));
      throw error;
    }
  }
}
