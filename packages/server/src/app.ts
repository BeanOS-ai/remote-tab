// The dead-drop HTTP API (design §5.3). JSON only; anything else is 404 (§5.5).
import {
  type AppendMessageRequest,
  type CreateSessionResponse,
  type ErrorCode,
  LIMITS,
  type RedeemResponse,
  type Role,
  type SessionStatus,
  UUID_V4_RE,
  type WireMessage,
} from "@remote-tab/protocol";
import { b64url, chainHash } from "@remote-tab/protocol/src/crypto";
import { bootstrapResponse } from "./bootstrap";
import { CreateRateLimiter, DEFAULT_THROTTLES, type ThrottleLimits, clientIp } from "./limits";
import {
  ChainMismatch,
  RateLimited,
  SessionNotActive,
  type SessionRecord,
  type Store,
  type StoredMessage,
} from "./store";

export interface AppOptions {
  store: Store;
  /** platform name → API key. Keys are compared in constant time. */
  apiKeys?: ReadonlyMap<string, string>;
  limits?: Partial<ThrottleLimits>;
  /** Only enable behind a proxy that replaces untrusted forwarded headers. */
  trustProxy?: boolean;
  now?: () => Date;
  /** Blob size cap; overridable in tests. */
  blobMaxBytes?: number;
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
  const m = h.match(/^Bearer\s+([A-Za-z0-9_\-.:]+)$/);
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
  const apiKeys = opts.apiKeys ?? new Map<string, string>();
  const limits = { ...DEFAULT_THROTTLES, ...opts.limits };
  const createRate = new CreateRateLimiter();

  function effectiveState(s: SessionRecord): SessionRecord {
    if (s.state !== "stopped" && s.state !== "expired" && new Date(s.expiresAt) <= now()) {
      return { ...s, state: "expired" };
    }
    return s;
  }

  async function authSession(
    req: Request,
    id: string,
    allowed: ReadonlyArray<Role>,
  ): Promise<{ session: SessionRecord; role: Role } | Response> {
    if (!UUID_V4_RE.test(id)) return fail(404, "not_found", "no such session");
    const token = bearer(req);
    if (!token) return fail(401, "unauthorized", "missing bearer token");
    const raw = await store.getSession(id);
    if (!raw) return fail(404, "not_found", "no such session");
    const session = effectiveState(raw);
    const h = await sha256Hex(token);
    let role: Role | null = null;
    if (constantTimeEqual(h, session.agentTokenHash)) role = "agent";
    else if (session.browserTokenHash && constantTimeEqual(h, session.browserTokenHash))
      role = "browser";
    if (!role || !allowed.includes(role))
      return fail(401, "unauthorized", "token not valid for this session");
    return { session, role };
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

  async function handle(req: Request, peer?: RequestPeer): Promise<Response> {
    const bootstrap = bootstrapResponse(req);
    if (bootstrap) return bootstrap;
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "sessions")
      return fail(404, "not_found", "no such route");

    // POST /v1/sessions
    if (parts.length === 2) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      const key = bearer(req);
      let platform: string | null = apiKeys.size === 0 ? "open" : null;
      for (const [name, k] of apiKeys) if (key && constantTimeEqual(key, k)) platform = name;
      if (!platform) return fail(401, "unauthorized", "invalid platform api key");
      const ip = clientIp(req, peer?.requestIP(req)?.address, opts.trustProxy === true);
      const retryAfter = createRate.take(ip, now().getTime(), limits.createPerMinute);
      if (retryAfter !== null) throw new RateLimited(retryAfter);
      let body: { ttl_seconds?: unknown } = {};
      try {
        const text = await req.text();
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        return fail(400, "invalid", "body must be JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return fail(400, "invalid", "body must be a JSON object");
      const ttl =
        body.ttl_seconds === undefined ? LIMITS.ttlDefaultSeconds : Number(body.ttl_seconds);
      if (!Number.isInteger(ttl) || ttl < 60)
        return fail(400, "invalid", "ttl_seconds must be an integer ≥ 60");
      if (ttl > LIMITS.ttlMaxSeconds)
        return fail(400, "ttl_exceeded", `ttl_seconds must be ≤ ${LIMITS.ttlMaxSeconds}`);
      const t = now();
      const agentToken = newToken();
      const record: SessionRecord = {
        id: crypto.randomUUID(),
        platform,
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
      return json(201, res);
    }

    const id = parts[2];
    const sub = parts[3];

    // POST /v1/sessions/{id}/redeem — no token; one-shot.
    if (sub === "redeem" && parts.length === 4) {
      if (req.method !== "POST") return fail(404, "not_found", "no such route");
      if (!UUID_V4_RE.test(id)) return fail(404, "not_found", "no such session");
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
      const a = await authSession(req, id, ["agent", "browser"]);
      if (a instanceof Response) return a;
      return json(200, status(a.session));
    }

    // /v1/sessions/{id}/messages
    if (sub === "messages" && parts.length === 4) {
      if (req.method === "POST") {
        const a = await authSession(req, id, ["agent", "browser"]);
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
        const a = await authSession(req, id, ["agent", "browser"]);
        if (a instanceof Response) return a;
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0)
          return fail(400, "invalid", "after must be a non-negative integer");
        const wait = Math.min(
          Number(url.searchParams.get("wait") ?? "0") || 0,
          LIMITS.longPollMaxSeconds,
        );
        let messages = await store.listMessages(id, after, 200);
        if (messages.length === 0 && wait > 0 && a.session.state === "active") {
          await store.waitForMessage(id, after, wait * 1000);
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
        const a = await authSession(req, id, ["agent", "browser"]);
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
        return json(201, { blob_id: blobId });
      }
      if (req.method === "GET" && parts.length === 5) {
        const a = await authSession(req, id, ["agent", "browser"]);
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
      const a = await authSession(req, id, ["browser"]);
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
      const a = await authSession(req, id, ["agent", "browser"]);
      if (a instanceof Response) return a;
      const updated = await store.updateSession(id, (cur) => ({ ...cur, state: "stopped" }));
      return json(200, status(updated ?? { ...a.session, state: "stopped" }));
    }

    return fail(404, "not_found", "no such route");
  }

  return {
    fetch: async (req: Request, peer?: RequestPeer) => {
      try {
        return await handle(req, peer);
      } catch (err) {
        if (err instanceof RateLimited) {
          return json(
            429,
            { error: "rate_limited", message: err.message },
            {
              "retry-after": String(err.retryAfterSeconds),
            },
          );
        }
        if (err instanceof SessionNotActive) return fail(409, "session_not_active", err.message);
        console.error("remote-tab server error", err);
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
