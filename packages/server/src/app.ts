// The dead-drop HTTP API (design §5.3). JSON only; anything else is 404 (§5.5).
import {
  type AppendMessageRequest,
  type CreateSessionResponse,
  type ErrorCode,
  LIMITS,
  type RedeemResponse,
  type Role,
  SESSION_ID_RE,
  type SessionStatus,
  type WireMessage,
} from "@remote-tab/protocol";
import { b64url, chainHash } from "@remote-tab/protocol/src/crypto";
import { bootstrapResponses } from "./bootstrap";
import {
  type KeyResolver,
  KeyServiceUnavailable,
  StaticKeyResolver,
  hashKey,
} from "./key-resolver";
import { DEFAULT_THROTTLES, type ThrottleLimits, clientIp } from "./limits";
import { QpsLimiter } from "./qps-limiter";
import {
  ChainMismatch,
  RateLimited,
  SessionIdTaken,
  SessionNotActive,
  type SessionRecord,
  type Store,
  type StoredMessage,
} from "./store";
import { LogUsageSink, type UsageEvent, type UsageSink } from "./usage";

export interface AppOptions {
  store: Store;
  /** Legacy static configuration; prefer keyResolver for explicit QPS policy. */
  apiKeys?: ReadonlyMap<string, string>;
  keyResolver?: KeyResolver;
  /** Zero requires a valid key or a session created with one. */
  anonymousQps?: number;
  usageSink?: UsageSink;
  trustProxyHops?: number;
  limits?: Partial<ThrottleLimits>;
  /** Only enable behind a proxy that replaces untrusted forwarded headers. */
  trustProxy?: boolean;
  now?: () => Date;
  /** Blob size cap; overridable in tests. */
  blobMaxBytes?: number;
  /** Origin agents use for this relay, shown in /docs; never derived from requests. */
  publicOrigin?: string;
}

const BLOB_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function fail(status: number, error: ErrorCode, message: string): Response {
  return json(status, { error, message });
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer[ \t]+([^\s]+)$/i);
  return m ? m[1] : null;
}

function toWire(m: StoredMessage): WireMessage {
  return {
    seq: m.seq,
    role: m.role,
    prev_hash: m.prevHash,
    hash: m.hash,
    nonce: m.nonce,
    ciphertext: m.ciphertext,
    created_at: m.createdAt,
  };
}

export interface RequestPeer {
  requestIP(req: Request): { address: string } | null;
}

export function createApp(opts: AppOptions): {
  fetch: (req: Request, peer?: RequestPeer) => Promise<Response>;
} {
  const { store } = opts;
  const now = opts.now ?? (() => new Date());
  const blobMax = opts.blobMaxBytes ?? LIMITS.blobMaxBytes;
  const resolver = opts.keyResolver ?? new StaticKeyResolver(opts.apiKeys);
  const anonymousQps = opts.anonymousQps ?? 10;
  if (!Number.isSafeInteger(anonymousQps) || anonymousQps < 0)
    throw new Error("anonymousQps must be a nonnegative safe integer");
  const limits = { ...DEFAULT_THROTTLES, ...opts.limits };
  const bootstrapResponse = bootstrapResponses(opts.publicOrigin);
  const qps = new QpsLimiter();
  const usage = opts.usageSink ?? new LogUsageSink({ now: () => now().getTime() });
  type Identity =
    | { subject: string; tier: string; ip?: never }
    | { ip: string; tier: string; subject?: never };
  interface Context {
    ip: string;
    identity: Identity;
    charged: boolean;
    binding?: { keyHash: string; subject: string };
    authenticated?: { session: SessionRecord; role: Role | null };
  }
  function recordUsage(ctx: Context, kind: UsageEvent["kind"], amount: number): void {
    try {
      // Custom sinks cannot turn a successful operation into a failure either.
      void Promise.resolve(
        usage.record({ ...ctx.identity, kind, amount, at: now().toISOString() }),
      ).catch(() => {});
    } catch {
      /* Usage is best effort, including injected sinks. */
    }
  }
  async function charge(
    ctx: Context,
    identity: Identity,
    allowance: number,
    denial = false,
  ): Promise<void> {
    ctx.identity = identity;
    ctx.charged = true;
    const namespace =
      identity.subject !== undefined
        ? "subject"
        : denial && anonymousQps === 0
          ? "denied-ip"
          : "ip";
    await qps.consume(JSON.stringify([namespace, identity.subject ?? identity.ip]), allowance);
  }
  const denialCharge = (ctx: Context) =>
    charge(ctx, { ip: ctx.ip, tier: "anonymous" }, anonymousQps || 10, true);
  async function deny(
    ctx: Context,
    status: number,
    code: ErrorCode,
    message: string,
  ): Promise<Response> {
    await denialCharge(ctx);
    return fail(status, code, message);
  }
  async function resolvePolicy(ctx: Context, key: string, hashed: boolean) {
    try {
      return await (hashed ? resolver.resolveHash(key) : resolver.resolve(key));
    } catch {
      await denialCharge(ctx);
      throw new KeyServiceUnavailable();
    }
  }
  async function admit(req: Request, ctx: Context): Promise<Response | undefined> {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const isSession = parts[0] === "v1" && parts[1] === "sessions" && parts.length >= 3;
    if (isSession) {
      const id = parts[2];
      if (!SESSION_ID_RE.test(id)) return deny(ctx, 404, "not_found", "no such session");
      const raw = await store.getSession(id);
      if (!raw) return deny(ctx, 404, "not_found", "no such session");
      const redeem = parts.length === 4 && parts[3] === "redeem" && req.method === "POST";
      let role: Role | null = null;
      if (!redeem) {
        const token = bearer(req);
        if (!token) return deny(ctx, 401, "unauthorized", "missing bearer token");
        const hashed = await sha256Hex(token);
        if (constantTimeEqual(hashed, raw.agentTokenHash)) role = "agent";
        else if (raw.browserTokenHash && constantTimeEqual(hashed, raw.browserTokenHash))
          role = "browser";
        if (!role) return deny(ctx, 401, "unauthorized", "token not valid for this session");
      }
      ctx.authenticated = { session: effectiveState(raw), role };
      if (raw.keyBinding) {
        const claims = await resolvePolicy(ctx, raw.keyBinding.keyHash, true);
        if (!claims || claims.subject !== raw.keyBinding.subject)
          return deny(ctx, 401, "unauthorized", "session key is no longer authorized");
        await charge(ctx, { subject: claims.subject, tier: claims.tier }, claims.qps);
        return;
      }
    } else if (req.headers.has("authorization")) {
      const key = bearer(req);
      if (!key) return deny(ctx, 401, "unauthorized", "invalid platform api key");
      const claims = await resolvePolicy(ctx, key, false);
      if (!claims) return deny(ctx, 401, "unauthorized", "invalid platform api key");
      ctx.binding = { keyHash: await hashKey(key), subject: claims.subject };
      await charge(ctx, { subject: claims.subject, tier: claims.tier }, claims.qps);
      return;
    }
    if (anonymousQps === 0) return deny(ctx, 401, "unauthorized", "platform api key required");
    await charge(ctx, { ip: ctx.ip, tier: "anonymous" }, anonymousQps);
  }

  function effectiveState(s: SessionRecord): SessionRecord {
    if (s.state !== "stopped" && s.state !== "expired" && new Date(s.expiresAt) <= now()) {
      return { ...s, state: "expired" };
    }
    return s;
  }

  async function authSession(
    ctx: Context,
    id: string,
    allowed: ReadonlyArray<Role>,
  ): Promise<{ session: SessionRecord; role: Role } | Response> {
    const auth = ctx.authenticated;
    if (!auth || auth.session.id !== id || !auth.role)
      return fail(401, "unauthorized", "token not valid for this session");
    // Authenticated for this session, but the route belongs to the other role.
    if (!allowed.includes(auth.role))
      return fail(403, "forbidden", `the ${auth.role} token cannot use this route`);
    // Key-service resolution may outlast the session TTL. Re-evaluate the
    // captured record at the authorization boundary after that await.
    return { session: effectiveState(auth.session), role: auth.role };
  }

  function status(s: SessionRecord): SessionStatus {
    return {
      id: s.id,
      state: s.state,
      expires_at: s.expiresAt,
      last_seq: s.lastSeq,
      last_hash: s.lastHash,
      redeemed: s.browserTokenHash !== null,
    };
  }

  async function handle(req: Request, ctx: Context): Promise<Response> {
    const bootstrap = bootstrapResponse(req);
    if (bootstrap) return bootstrap;
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "sessions")
      return fail(404, "not_found", "no such route");

    // POST /v1/sessions
    if (parts.length === 2) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      const ip = ctx.ip;
      const platform = ctx.identity.subject ?? "open";
      let body: { id?: unknown; ttl_seconds?: unknown } = {};
      try {
        const text = await req.text();
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        return fail(400, "invalid", "body must be JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return fail(400, "invalid", "body must be a JSON object");
      if (typeof body.id !== "string" || !SESSION_ID_RE.test(body.id))
        return fail(400, "invalid", "id must be 32 lowercase hexadecimal characters");
      const ttl =
        body.ttl_seconds === undefined ? LIMITS.ttlDefaultSeconds : Number(body.ttl_seconds);
      if (!Number.isInteger(ttl) || ttl < 60)
        return fail(400, "invalid", "ttl_seconds must be an integer ≥ 60");
      if (ttl > LIMITS.ttlMaxSeconds)
        return fail(400, "ttl_exceeded", `ttl_seconds must be ≤ ${LIMITS.ttlMaxSeconds}`);
      const t = now();
      const agentToken = newToken();
      const record: SessionRecord = {
        id: body.id,
        platform,
        ...(ctx.binding && { keyBinding: ctx.binding }),
        state: "created",
        createdAt: t.toISOString(),
        expiresAt: new Date(t.getTime() + ttl * 1000).toISOString(),
        redeemUntil: new Date(t.getTime() + LIMITS.redeemWindowSeconds * 1000).toISOString(),
        ttlSeconds: ttl,
        agentTokenHash: await sha256Hex(agentToken),
        browserTokenHash: null,
        lastSeq: 0,
        lastHash: "",
      };
      await store.createSession(record, {
        clientIp: ip,
        activePerIp: limits.activePerIp,
        activeMax: limits.activeMax,
        now: t,
      });
      const res: CreateSessionResponse = {
        id: record.id,
        agent_token: agentToken,
        expires_at: record.expiresAt,
        redeem_until: record.redeemUntil,
      };
      recordUsage(ctx, "session_created", 1);
      return json(201, res);
    }

    const id = parts[2];
    const sub = parts[3];

    // POST /v1/sessions/{id}/redeem — no token; one-shot.
    if (sub === "redeem" && parts.length === 4) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      if (!SESSION_ID_RE.test(id)) return fail(404, "not_found", "no such session");
      const browserToken = newToken();
      const hash = await sha256Hex(browserToken);
      const outcome = { v: "missing" as "ok" | "already" | "closed" | "missing" | "inactive" };
      const updated = await store.updateSession(id, (cur) => {
        const s = effectiveState(cur);
        if (s.state === "stopped" || s.state === "expired") {
          outcome.v = "inactive";
          return null;
        }
        if (s.browserTokenHash) {
          outcome.v = "already";
          return null;
        }
        if (new Date(s.redeemUntil) <= now()) {
          outcome.v = "closed";
          return null;
        }
        outcome.v = "ok";
        return { ...s, browserTokenHash: hash, state: "active" };
      });
      if (!updated) {
        if (outcome.v === "already")
          return fail(409, "already_redeemed", "this code was already redeemed");
        if (outcome.v === "closed")
          return fail(410, "redeem_window_closed", "the redeem window has closed");
        if (outcome.v === "inactive")
          return fail(409, "session_not_active", "session is stopped or expired");
        return fail(404, "not_found", "no such session");
      }
      const res: RedeemResponse = { browser_token: browserToken, expires_at: updated.expiresAt };
      return json(200, res);
    }

    // GET /v1/sessions/{id}
    if (parts.length === 3) {
      if (req.method !== "GET") return fail(404, "not_found", "no such route");
      const a = await authSession(ctx, id, ["agent", "browser"]);
      if (a instanceof Response) return a;
      return json(200, status(a.session));
    }

    // /v1/sessions/{id}/messages
    if (sub === "messages" && parts.length === 4) {
      if (req.method === "POST") {
        const a = await authSession(ctx, id, ["agent", "browser"]);
        if (a instanceof Response) return a;
        if (a.session.state !== "active")
          return fail(409, "session_not_active", `session is ${a.session.state}`);
        const text = await req.text();
        if (new TextEncoder().encode(text).byteLength > LIMITS.messageMaxBytes) {
          return fail(413, "too_large", `message exceeds ${LIMITS.messageMaxBytes} bytes`);
        }
        let body: AppendMessageRequest;
        try {
          body = JSON.parse(text) as AppendMessageRequest;
        } catch {
          return fail(400, "invalid", "body must be JSON");
        }
        if (body.role !== a.role) return fail(400, "invalid", "role must match the token");
        if (
          typeof body.prev_hash !== "string" ||
          (body.prev_hash !== "" && !HEX_RE.test(body.prev_hash))
        ) {
          return fail(400, "invalid", "prev_hash must be hex sha256 or empty");
        }
        if (typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(body.nonce)) {
          return fail(400, "invalid", "nonce must be 12 bytes base64url");
        }
        if (typeof body.ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,}$/.test(body.ciphertext)) {
          return fail(400, "invalid", "ciphertext must be base64url");
        }
        try {
          const stored = await store.appendMessage(
            id,
            {
              role: body.role,
              prevHash: body.prev_hash,
              nonce: body.nonce,
              ciphertext: body.ciphertext,
            },
            (seq) => chainHash(id, seq, body.ciphertext),
            limits.messagesMax,
          );
          recordUsage(ctx, "message", 1);
          return json(201, { seq: stored.seq, hash: stored.hash });
        } catch (err) {
          if (err instanceof SessionNotActive) {
            return fail(409, "session_not_active", err.message);
          }
          if (err instanceof ChainMismatch) {
            return json(409, {
              error: "chain_mismatch",
              message: "prev_hash is stale",
              expected_prev_hash: err.expectedPrevHash,
            });
          }
          throw err;
        }
      }
      if (req.method === "GET") {
        const a = await authSession(ctx, id, ["agent", "browser"]);
        if (a instanceof Response) return a;
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0)
          return fail(400, "invalid", "after must be a non-negative integer");
        const wait = Math.min(
          Number(url.searchParams.get("wait") ?? "0") || 0,
          LIMITS.longPollMaxSeconds,
        );
        let messages = await store.listMessages(id, after, 200);
        if (messages.length === 0 && wait > 0 && a.session.state === "active") {
          await store.waitForMessage(id, after, wait * 1000, req.signal);
          messages = await store.listMessages(id, after, 200);
        }
        const fresh = await store.getSession(id);
        return json(200, {
          messages: messages.map(toWire),
          state: fresh ? effectiveState(fresh).state : a.session.state,
        });
      }
      return fail(404, "not_found", "no such route");
    }

    // /v1/sessions/{id}/blobs[/{blobId}]
    if (sub === "blobs") {
      if (req.method === "POST" && parts.length === 4) {
        const a = await authSession(ctx, id, ["agent", "browser"]);
        if (a instanceof Response) return a;
        if (a.session.state !== "active")
          return fail(409, "session_not_active", `session is ${a.session.state}`);
        const len = Number(req.headers.get("content-length") ?? "0");
        if (len > blobMax) return fail(413, "too_large", `blob exceeds ${blobMax} bytes`);
        const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength === 0) return fail(400, "invalid", "empty blob");
        if (bytes.byteLength > blobMax)
          return fail(413, "too_large", `blob exceeds ${blobMax} bytes`);
        const blobId = b64url(crypto.getRandomValues(new Uint8Array(18)));
        await store.putBlob(id, blobId, bytes, limits.blobBudgetBytes);
        recordUsage(ctx, "blob_bytes", bytes.byteLength);
        return json(201, { blob_id: blobId });
      }
      if (req.method === "GET" && parts.length === 5) {
        const a = await authSession(ctx, id, ["agent", "browser"]);
        if (a instanceof Response) return a;
        const blobId = parts[4];
        if (!BLOB_ID_RE.test(blobId)) return fail(404, "not_found", "no such blob");
        const bytes = await store.getBlob(id, blobId);
        if (!bytes) return fail(404, "not_found", "no such blob");
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        });
      }
      return fail(404, "not_found", "no such route");
    }

    // POST /v1/sessions/{id}/extend — browser only
    if (sub === "extend" && parts.length === 4) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      const a = await authSession(ctx, id, ["browser"]);
      if (a instanceof Response) return a;
      if (a.session.state !== "active")
        return fail(409, "session_not_active", `session is ${a.session.state}`);
      let exceeded = false;
      let inactive = false;
      const updated = await store.updateSession(id, (cur) => {
        if (effectiveState(cur).state !== "active") {
          inactive = true;
          return null;
        }
        const total = cur.ttlSeconds + LIMITS.ttlDefaultSeconds;
        if (total > LIMITS.ttlMaxSeconds) {
          exceeded = true;
          return null;
        }
        return {
          ...cur,
          ttlSeconds: total,
          expiresAt: new Date(
            new Date(cur.expiresAt).getTime() + LIMITS.ttlDefaultSeconds * 1000,
          ).toISOString(),
        };
      });
      if (!updated) {
        if (inactive) return fail(409, "session_not_active", "session is stopped or expired");
        return exceeded
          ? fail(409, "ttl_exceeded", `session already at the ${LIMITS.ttlMaxSeconds}s maximum`)
          : fail(404, "not_found", "no such session");
      }
      return json(200, status(updated));
    }

    // POST /v1/sessions/{id}/stop
    if (sub === "stop" && parts.length === 4) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      const a = await authSession(ctx, id, ["agent", "browser"]);
      if (a instanceof Response) return a;
      const updated = await store.updateSession(id, (cur) => ({ ...cur, state: "stopped" }));
      return json(200, status(updated ?? { ...a.session, state: "stopped" }));
    }

    return fail(404, "not_found", "no such route");
  }

  return {
    fetch: async (req: Request, peer?: RequestPeer) => {
      const ctx: Context = {
        ip: "unknown",
        identity: { ip: "unknown", tier: "anonymous" },
        charged: false,
      };
      try {
        ctx.ip = clientIp(
          req,
          peer?.requestIP(req)?.address,
          opts.trustProxy === true,
          opts.trustProxyHops,
        );
        const denied = await admit(req, ctx);
        if (denied) return denied;
        return await handle(req, ctx);
      } catch (err) {
        if (err instanceof RateLimited) {
          recordUsage(ctx, "throttled", 1);
          return json(
            429,
            { error: "rate_limited", message: err.message },
            {
              "retry-after": String(err.retryAfterSeconds),
            },
          );
        }
        if (err instanceof KeyServiceUnavailable)
          return fail(503, "key_service_unavailable", "key service unavailable");
        if (err instanceof SessionIdTaken) return fail(409, "id_taken", err.message);
        if (err instanceof SessionNotActive) return fail(409, "session_not_active", err.message);
        console.error("remote-tab server error");
        return fail(500, "invalid", "internal error");
      }
    },
  };
}

/** Parse `platform:key,platform2:key2` from the environment. */
export function parseApiKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(":");
    if (i <= 0) throw new Error("REMOTE_TAB_API_KEYS entries must be platform:key");
    map.set(trimmed.slice(0, i), trimmed.slice(i + 1));
  }
  return map;
}
