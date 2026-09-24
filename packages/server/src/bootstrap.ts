import assets from "./generated/bootstrap.json";

/** Stands in for the relay origin in /docs until REMOTE_TAB_PUBLIC_ORIGIN is configured. */
export const ORIGIN_PLACEHOLDER = "https://your-relay.example";

/**
 * The origin agents use to reach this relay. It is configuration, never derived from
 * request headers, because /docs and /client-code tell agents where to send the session.
 * The pattern also keeps the value inert inside the generated shell script.
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

/** `/client-code`: a POSIX sh wrapper that runs the official npm package release. */
export function clientScript(origin: string | undefined, version = assets.version): string {
  return [
    "#!/bin/sh",
    `# remote-tab ${version} agent CLI: runs the official remote-tab npm package (Node.js 20+).`,
    "# Usage: ./remote-tab --help. Read ./remote-tab skill before creating a session.",
    "set -eu",
    ...(origin ? [`: "\${REMOTE_TAB_SERVER_URL:=${origin}}"`, "export REMOTE_TAB_SERVER_URL"] : []),
    `exec npx -y remote-tab@${version} "$@"`,
    "",
  ].join("\n");
}

/** Exact allowlist, backed only by build-time assets; never reads the filesystem. */
export function bootstrapResponses(publicOrigin?: string) {
  const origin = parsePublicOrigin(publicOrigin);
  const docs = origin ? assets.docs.replaceAll(ORIGIN_PLACEHOLDER, origin) : assets.docs;
  const script = clientScript(origin);
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
    if (path === "/client-code")
      return new Response(script, {
        headers: {
          ...headers,
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="remote-tab"',
        },
      });
    return null;
  };
}
