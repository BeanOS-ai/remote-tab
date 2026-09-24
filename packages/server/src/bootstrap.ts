import assets from "./generated/bootstrap.json";

/** Stands in for the relay origin in /docs until REMOTE_TAB_PUBLIC_ORIGIN is configured. */
export const ORIGIN_PLACEHOLDER = "https://your-relay.example";

/**
 * The origin agents use to reach this relay. It is configuration, never derived from
 * request headers, because /docs tells agents where to send the session.
 */
export function parsePublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = value.replace(/\/$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin) || new URL(origin).origin !== origin)
    throw new Error(
      "REMOTE_TAB_PUBLIC_ORIGIN must be an http(s) origin such as https://tab.example",
    );
  return origin;
}

/** Exact allowlist, backed only by build-time assets; never reads the filesystem. */
export function bootstrapResponses(publicOrigin?: string) {
  const origin = parsePublicOrigin(publicOrigin);
  const docs = origin ? assets.docs.replaceAll(ORIGIN_PLACEHOLDER, origin) : assets.docs;
  const headers = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-cache",
  };
  return (req: Request): Response | null => {
    if (req.method !== "GET") return null;
    const path = new URL(req.url).pathname;
    if (path === "/docs")
      return new Response(docs, {
        headers: { ...headers, "content-type": "text/markdown; charset=utf-8" },
      });
    return null;
  };
}
