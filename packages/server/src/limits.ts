import { isIP } from "node:net";

export interface ThrottleLimits {
  activePerIp: number;
  activeMax: number;
  blobBudgetBytes: number;
  messagesMax: number;
}

export const DEFAULT_THROTTLES: Readonly<ThrottleLimits> = {
  activePerIp: 20,
  activeMax: 500,
  blobBudgetBytes: 64 * 1024 * 1024,
  messagesMax: 5000,
};

export function parseThrottleEnv(env: Record<string, string | undefined>): ThrottleLimits {
  const names: Record<keyof ThrottleLimits, string> = {
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

/** Explicit hop count wins over the legacy replace-header mode; zero trusts only the socket. */
export function clientIp(
  req: Request,
  peer: string | undefined,
  trustProxy: boolean,
  trustedHops?: number,
): string {
  const socket = (peer && normalizeIp(peer)) || "unknown";
  if (trustedHops !== undefined) {
    if (!Number.isSafeInteger(trustedHops) || trustedHops < 0 || trustedHops === 0) return socket;
    // A missing/invalid socket cannot establish the end of a trusted proxy chain.
    if (socket === "unknown") return socket;
    const forwarded = req.headers.get("x-forwarded-for");
    if (!forwarded) return socket;
    const chain = forwarded.split(",").map((part) => normalizeIp(part.trim()));
    if (chain.some((ip) => ip === null)) return socket;
    chain.push(socket);
    const index = chain.length - 1 - trustedHops;
    return index >= 0 ? (chain[index] ?? socket) : socket;
  }
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded && normalizeIp(forwarded);
    if (ip) return ip;
  }
  return socket;
}

export function parseTrustedProxyHops(env: Record<string, string | undefined>): number | undefined {
  const raw = env.REMOTE_TAB_TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("REMOTE_TAB_TRUST_PROXY_HOPS must be a nonnegative safe integer");
  return value;
}
