/** Best-effort usage reporting. Payloads are rebuilt from this allowlist, never copied wholesale. */
export type UsageKind = "session_created" | "message" | "blob_bytes" | "throttled";
export type UsageEvent = ({ subject: string; ip?: never } | { ip: string; subject?: never }) & {
  tier: string;
  kind: UsageKind;
  amount: number;
  at: string;
};
export interface UsageSink {
  record(event: UsageEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export const MAX_USAGE_AMOUNT = 1024 * 1024 * 1024;
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 32_768;
const encoder = new TextEncoder();
const kinds = new Set<UsageKind>(["session_created", "message", "blob_bytes", "throttled"]);
const validText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

function clean(event: UsageEvent): UsageEvent | undefined {
  if (!event || typeof event !== "object") return;
  const subject = validText(event.subject);
  const ip = validText(event.ip);
  if (
    subject === ip ||
    (subject && event.ip !== undefined) ||
    (ip && event.subject !== undefined) ||
    !validText(event.tier) ||
    !kinds.has(event.kind) ||
    !Number.isSafeInteger(event.amount) ||
    event.amount <= 0 ||
    typeof event.at !== "string" ||
    event.at.length > 40 ||
    !Number.isFinite(Date.parse(event.at))
  )
    return;
  return {
    ...(subject ? { subject: event.subject as string } : { ip: event.ip as string }),
    tier: event.tier,
    kind: event.kind,
    amount: event.amount,
    at: new Date(event.at).toISOString(),
  };
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}
function safeLog(logger: (line: string) => void, line: string): void {
  try {
    logger(line);
  } catch {
    /* Reporting cannot affect the API. */
  }
}

interface LogOptions {
  now?: () => number;
  logger?: (line: string) => void;
  maxAggregates?: number;
  flushIntervalMs?: number;
}
/** Aggregates by UTC event minute, identity type/value, tier and kind. */
export class LogUsageSink implements UsageSink {
  private readonly groups = new Map<string, UsageEvent[]>();
  private count = 0;
  private closed = false;
  private readonly now: () => number;
  private readonly logger: (line: string) => void;
  private readonly maximum: number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(options: LogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console.log;
    this.maximum = positive(options.maxAggregates ?? 1000, "maxAggregates");
    this.timer = setInterval(
      () => this.drain(Math.floor(this.now() / 60_000) * 60_000),
      positive(options.flushIntervalMs ?? 1000, "flushIntervalMs"),
    );
    this.timer.unref?.();
  }
  record(event: UsageEvent): void {
    try {
      if (this.closed) return;
      const item = clean(event);
      if (!item) return;
      const at = new Date(Math.floor(Date.parse(item.at) / 60_000) * 60_000).toISOString();
      const key = JSON.stringify([
        at,
        "subject" in item ? "subject" : "ip",
        item.subject ?? item.ip,
        item.tier,
        item.kind,
      ]);
      const parts = this.groups.get(key) ?? [];
      let remaining = item.amount;
      while (remaining > 0) {
        let part = parts.at(-1);
        if (!part || part.amount === MAX_USAGE_AMOUNT) {
          if (this.count >= this.maximum) return;
          part = { ...item, amount: 0, at };
          parts.push(part);
          this.groups.set(key, parts);
          this.count++;
        }
        const amount = Math.min(remaining, MAX_USAGE_AMOUNT - part.amount);
        part.amount += amount;
        remaining -= amount;
      }
    } catch {
      /* Malformed events and reporting errors are isolated from request handling. */
    }
  }
  private drain(before: number): void {
    for (const [key, parts] of this.groups) {
      if (Date.parse(parts[0].at) >= before) continue;
      this.groups.delete(key);
      this.count -= parts.length;
      for (const event of parts) safeLog(this.logger, JSON.stringify(event));
    }
  }
  async flush(): Promise<void> {
    this.drain(Number.POSITIVE_INFINITY);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }
}

interface HttpOptions {
  url: string;
  token: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  logger?: (line: string) => void;
  flushIntervalMs?: number;
  timeoutMs?: number;
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
}
function usageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid usage service URL");
  }
  const host = url.hostname.replace(/\.$/, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d+){3}$/.test(host);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Usage service URL must use HTTPS (HTTP loopback is allowed) without credentials, query, or fragment",
    );
  return url.href;
}
/** Single in-flight POST, bounded queue, no retries of ambiguously delivered batches. */
export class HttpUsageSink implements UsageSink {
  private readonly queue: { json: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private dropped = false;
  private closed = false;
  private running?: Promise<void>;
  private transportPending = false;
  private readonly url: string;
  private readonly token: string;
  private readonly fetcher: NonNullable<HttpOptions["fetch"]>;
  private readonly logger: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(options: HttpOptions) {
    this.url = usageUrl(options.url);
    if (!options.token || /[\r\n]/.test(options.token))
      throw new Error("Usage service token is required and must be a single line");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? console.warn;
    this.timeoutMs = positive(options.timeoutMs ?? 2000, "timeoutMs");
    this.maxEvents = positive(options.maxQueuedEvents ?? 1000, "maxQueuedEvents");
    this.maxBytes = positive(options.maxQueuedBytes ?? 256 * 1024, "maxQueuedBytes");
    this.timer = setInterval(
      () => {
        void this.flush();
      },
      positive(options.flushIntervalMs ?? 1000, "flushIntervalMs"),
    );
    this.timer.unref?.();
  }
  record(event: UsageEvent): void {
    try {
      if (this.closed) return;
      const item = clean(event);
      if (!item) return;
      let remaining = item.amount;
      while (remaining > 0) {
        const amount = Math.min(remaining, MAX_USAGE_AMOUNT);
        const json = JSON.stringify({ ...item, amount });
        const bytes = encoder.encode(json).byteLength;
        if (
          this.queue.length >= this.maxEvents ||
          this.queuedBytes + bytes > this.maxBytes ||
          bytes + 2 > MAX_BATCH_BYTES
        ) {
          this.dropped = true;
          return;
        }
        this.queue.push({ json, bytes });
        this.queuedBytes += bytes;
        remaining -= amount;
      }
    } catch {
      /* No event can cause an API failure. */
    }
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = Promise.resolve()
      .then(async () => {
        while (this.queue.length && !this.transportPending) {
          const batch: string[] = [];
          let size = 2; // JSON array brackets.
          while (this.queue.length && batch.length < MAX_BATCH_EVENTS) {
            const next = this.queue[0];
            const added = next.bytes + (batch.length ? 1 : 0);
            if (size + added > MAX_BATCH_BYTES) break;
            this.queue.shift();
            this.queuedBytes -= next.bytes;
            batch.push(next.json);
            size += added;
          }
          await this.send(`[${batch.join(",")}]`);
        }
        if (this.dropped) {
          this.dropped = false;
          safeLog(this.logger, "remote-tab usage queue full; excess events dropped");
        }
      })
      .catch(() => safeLog(this.logger, "remote-tab usage delivery failed"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async send(body: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.transportPending = true;
      await Promise.race([
        Promise.resolve()
          .then(async () => {
            const response = await this.fetcher(this.url, {
              method: "POST",
              redirect: "error",
              headers: {
                authorization: `Bearer ${this.token}`,
                "content-type": "application/json",
              },
              body,
              signal: controller.signal,
            });
            void response.body?.cancel().catch(() => {});
            if (!response.ok) throw new Error("usage delivery rejected");
          })
          .finally(() => {
            this.transportPending = false;
          }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("usage delivery timed out"));
          }, this.timeoutMs);
        }),
      ]);
    } catch {
      safeLog(this.logger, "remote-tab usage delivery failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
    // An injected transport may ignore AbortSignal. Never start overlapping
    // requests; closing still discards any remaining best-effort queue promptly.
    this.queue.length = 0;
    this.queuedBytes = 0;
  }
}
