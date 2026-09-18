import assets from "./generated/bootstrap.json";

/** Exact allowlist, backed only by build-time assets; never reads the filesystem. */
export function bootstrapResponse(req: Request): Response | null {
  const path = new URL(req.url).pathname;
  if (req.method !== "GET") return null;
  const headers = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-cache",
  };
  if (path === "/docs") {
    return new Response(assets.docs, {
      headers: { ...headers, "content-type": "text/markdown; charset=utf-8" },
    });
  }
  if (path === "/client-code") {
    return Response.json(assets.index, { headers });
  }
  if (!path.startsWith("/client-code/")) return null;
  const key = path.slice("/client-code/".length);
  if (!Object.hasOwn(assets.sources, key)) return null;
  const source = (assets.sources as Record<string, string>)[key];
  return new Response(source, {
    headers: {
      ...headers,
      "content-type": key.endsWith(".ts")
        ? "application/typescript; charset=utf-8"
        : "text/plain; charset=utf-8",
      "content-disposition": "attachment",
    },
  });
}
