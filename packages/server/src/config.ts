import { HttpKeyResolver, StaticKeyResolver } from "./key-resolver";
import { parseThrottleEnv, parseTrustedProxyHops } from "./limits";
import { HttpUsageSink, LogUsageSink } from "./usage";

/** Parse an optional integer without silently accepting malformed deployment settings. */
export function nonnegativeEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}

export function serverPolicy(env: Record<string, string | undefined>) {
  const serviceToken = () => {
    const token = env.REMOTE_TAB_KEY_SERVICE_TOKEN;
    if (!token)
      throw new Error("REMOTE_TAB_KEY_SERVICE_TOKEN is required for HTTP key/usage services");
    return token;
  };
  const anonymousQps = nonnegativeEnv(env, "REMOTE_TAB_ANONYMOUS_QPS", 10);
  const cacheSeconds = nonnegativeEnv(env, "REMOTE_TAB_KEY_CACHE_SECONDS", 300);
  const limits = parseThrottleEnv(env);
  const trustProxyHops = parseTrustedProxyHops(env);
  const keyResolver = env.REMOTE_TAB_KEY_SERVICE_URL
    ? new HttpKeyResolver({
        url: env.REMOTE_TAB_KEY_SERVICE_URL,
        token: serviceToken(),
        cacheSeconds,
      })
    : new StaticKeyResolver(env.REMOTE_TAB_API_KEYS);
  const usageSink = env.REMOTE_TAB_USAGE_URL
    ? new HttpUsageSink({ url: env.REMOTE_TAB_USAGE_URL, token: serviceToken() })
    : new LogUsageSink();
  return {
    keyResolver,
    anonymousQps,
    usageSink,
    limits,
    trustProxyHops,
    trustProxy: env.REMOTE_TAB_TRUST_PROXY === "1",
  };
}
