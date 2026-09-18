import { isIP } from "node:net";

export interface ThrottleLimits {
  createPerMinute: number;
  activePerIp: number;
  activeMax: number;
  blobBudgetBytes: number;
  messagesMax: number;
}

export const DEFAULT_THROTTLES: Readonly<ThrottleLimits> = {
  createPerMinute: 10,
  activePerIp: 20,
  activeMax: 500,
  blobBudgetBytes: 64 * 1024 * 1024,
  messagesMax: 5000,
};

export function parseThrottleEnv(env: Record<string, string | undefined>): ThrottleLimits {
  const names: Record<keyof ThrottleLimits, string> = {
    createPerMinute: "REMOTE_TAB_CREATE_PER_MINUTE",
    activePerIp: "REMOTE_TAB_ACTIVE_PER_IP",
    activeMax: "REMOTE_TAB_ACTIVE_MAX",
    blobBudgetBytes: "REMOTE_TAB_BLOB_BUDGET_BYTES",
    messagesMax: "REMOTE_TAB_MESSAGES_MAX",
  };
  const limits = { ...DEFAULT_THROTTLES };
  for (const key of Object.keys(names) as (keyof ThrottleLimits)[]) {
    const raw = env[names[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${names[key]} must be a positive safe integer`);
    }
    limits[key] = value;
  }
  return limits;
}

function normalizeIp(value: string): string | null {
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6 && !value.includes("%")) {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    // Treat IPv4-mapped IPv6 and native IPv4 peers as the same client.
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (mapped) {
      const a = Number.parseInt(mapped[1], 16);
      const b = Number.parseInt(mapped[2], 16);
      return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return canonical;
  }
  return null;
}

export function clientIp(req: Request, peer: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded && normalizeIp(forwarded);
    if (ip) return ip;
  }
  return (peer && normalizeIp(peer)) || "unknown";
}

/** Fixed 60-second windows per IP, local to this app instance. */
export class CreateRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  take(ip: string, nowMs: number, max: number): number | null {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= nowMs) this.windows.delete(key);
    }
    const window = this.windows.get(ip) ?? { count: 0, resetAt: nowMs + 60_000 };
    this.windows.set(ip, window);
    if (window.count >= max) return Math.max(1, Math.ceil((window.resetAt - nowMs) / 1000));
    window.count++;
    return null;
  }
}
