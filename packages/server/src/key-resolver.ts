import { createHash } from "node:crypto";

export interface KeyClaims {
  tier: string;
  qps: number;
  subject: string;
}
export interface KeyResolver {
  resolve(rawKey: string): Promise<KeyClaims | null>;
  resolveHash(fingerprint: string): Promise<KeyClaims | null>;
}
export class KeyServiceUnavailable extends Error {
  constructor() {
    super("key service unavailable");
    this.name = "KeyServiceUnavailable";
  }
}
const HASH = /^[a-f0-9]{64}$/;
function digest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export async function hashKey(raw: string): Promise<string> {
  return digest(raw);
}
function claims(value: unknown): KeyClaims {
  const v = value as Partial<KeyClaims> | null;
  if (
    !v ||
    typeof v.tier !== "string" ||
    !v.tier.trim() ||
    v.tier.length > 256 ||
    typeof v.subject !== "string" ||
    !v.subject.trim() ||
    v.subject.length > 1024 ||
    !Number.isSafeInteger(v.qps) ||
    (v.qps as number) < 0
  ) {
    throw new Error("invalid key claims");
  }
  return { tier: v.tier, qps: v.qps as number, subject: v.subject };
}

/** Keeps fingerprints, never the configured plaintext keys. */
export class StaticKeyResolver implements KeyResolver {
  private readonly entries = new Map<string, KeyClaims>();
  constructor(
    input: string | ReadonlyMap<string, string> = "",
    options: { defaultQps?: number } = {},
  ) {
    const defaultQps = options.defaultQps ?? 10;
    claims({ tier: "static", subject: "validation", qps: defaultQps });
    const entries: [string, string, number][] = [];
    if (typeof input === "string") {
      for (const item of input.split(",")) {
        if (!item.trim()) continue;
        const separator = item.indexOf(":");
        if (separator < 1) throw new Error("invalid static key configuration");
        const subject = item.slice(0, separator).trim();
        let key = item.slice(separator + 1).trim();
        let qps = defaultQps;
        const last = key.lastIndexOf(":");
        if (last >= 0) {
          const suffix = key.slice(last + 1);
          if (
            suffix.trim() &&
            (!Number.isNaN(Number(suffix)) || /^(?:NaN|[+-]?Infinity)$/.test(suffix))
          ) {
            qps = Number(suffix);
            key = key.slice(0, last);
          }
        }
        entries.push([subject, key, qps]);
      }
    } else {
      for (const [subject, key] of input) entries.push([subject, key, defaultQps]);
    }
    for (const [subject, key, qps] of entries) {
      if (!key) throw new Error("invalid static key configuration");
      const value = claims({ tier: "static", subject, qps });
      const hash = digest(key);
      const existing = this.entries.get(hash);
      if (existing && (existing.subject !== subject || existing.qps !== qps)) {
        throw new Error("duplicate static key identity");
      }
      this.entries.set(hash, value);
    }
  }
  async resolve(rawKey: string): Promise<KeyClaims | null> {
    return this.resolveHash(digest(rawKey));
  }
  async resolveHash(fingerprint: string): Promise<KeyClaims | null> {
    const result = this.entries.get(fingerprint);
    return result ? { ...result } : null;
  }
}

export interface HttpKeyResolverOptions {
  url: string;
  token: string;
  cacheSeconds?: number;
  fetch?: (request: Request) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  maxEntries?: number;
  maxInFlight?: number;
}
export class HttpKeyResolver implements KeyResolver {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly fetcher: (request: Request) => Promise<Response>;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;
  private readonly cache = new Map<string, { value: KeyClaims | null; until: number }>();
  private activeRequests = 0;
  private readonly pending = new Map<string, Promise<KeyClaims | null>>();
  constructor(options: HttpKeyResolverOptions) {
    try {
      const url = new URL(options.url);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        /^127(?:\.\d+){3}$/.test(url.hostname) ||
        url.hostname === "[::1]";
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !options.token ||
        /[\r\n]/.test(options.token)
      )
        throw new Error();
      url.pathname = `${url.pathname.replace(/\/$/, "")}/resolve`;
      this.endpoint = url;
    } catch {
      throw new Error("invalid key service configuration");
    }
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttl = options.cacheSeconds ?? 300;
    this.timeout = options.timeoutMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 10000;
    this.maxInFlight = options.maxInFlight ?? 100;
    if (
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 0 ||
      this.ttl > 86400 ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000 ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isSafeInteger(this.maxInFlight) ||
      this.maxInFlight < 1
    )
      throw new Error("invalid key service configuration");
  }
  async resolve(rawKey: string): Promise<KeyClaims | null> {
    return this.resolveHash(digest(rawKey));
  }
  async resolveHash(fingerprint: string): Promise<KeyClaims | null> {
    if (!HASH.test(fingerprint)) throw new KeyServiceUnavailable();
    const cached = this.cache.get(fingerprint);
    if (cached && cached.until > this.now()) {
      this.cache.delete(fingerprint);
      this.cache.set(fingerprint, cached);
      return cached.value ? { ...cached.value } : null;
    }
    this.cache.delete(fingerprint);
    let pending = this.pending.get(fingerprint);
    if (!pending) {
      if (this.activeRequests >= this.maxInFlight) throw new KeyServiceUnavailable();
      pending = this.load(fingerprint);
      this.pending.set(fingerprint, pending);
    }
    try {
      const value = await pending;
      return value ? { ...value } : null;
    } finally {
      if (this.pending.get(fingerprint) === pending) this.pending.delete(fingerprint);
    }
  }
  private async load(fingerprint: string): Promise<KeyClaims | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new KeyServiceUnavailable());
      }, this.timeout);
    });
    try {
      this.activeRequests++;
      const request = this.request(fingerprint, controller.signal).finally(() => {
        this.activeRequests--;
      });
      const value = await Promise.race([request, timeout]);
      const seconds = value ? this.ttl : 60;
      if (seconds > 0) {
        if (this.cache.size >= this.maxEntries) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(fingerprint, { value, until: this.now() + seconds * 1000 });
      }
      return value;
    } catch {
      throw new KeyServiceUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  private async request(fingerprint: string, signal: AbortSignal): Promise<KeyClaims | null> {
    const url = new URL(this.endpoint);
    url.searchParams.set("key", fingerprint);
    const response = await this.fetcher(
      new Request(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal,
      }),
    );
    if (signal.aborted || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      if (!signal.aborted && response.status === 404) return null;
      throw new KeyServiceUnavailable();
    }
    if (Number(response.headers.get("content-length")) > 8192 || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new KeyServiceUnavailable();
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      let reads = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw new KeyServiceUnavailable();
        if (done) break;
        if (++reads > 8192) throw new KeyServiceUnavailable();
        length += value.byteLength;
        if (length > 8192) throw new KeyServiceUnavailable();
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return claims(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
    }
  }
}
