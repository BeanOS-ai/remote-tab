import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export function serverOrigin(value = "https://remote-tab.example"): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "REMOTE_TAB_SERVER_ORIGIN must be an HTTPS origin (HTTP loopback allowed for development)",
    );
  return url.origin;
}
export async function buildExtension(
  origin = serverOrigin(process.env.REMOTE_TAB_SERVER_ORIGIN),
  out = resolve(import.meta.dir, "../../dist/extension"),
) {
  const configuredOrigin = serverOrigin(origin);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const built = await Bun.build({
    entrypoints: ["worker", "popup"].map((name) => `${import.meta.dir}/src/${name}.ts`),
    outdir: out,
    target: "browser",
    format: "esm",
    minify: true,
    define: { REMOTE_TAB_SERVER_ORIGIN: JSON.stringify(configuredOrigin) },
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  await Bun.write(`${out}/popup.html`, Bun.file(`${import.meta.dir}/popup.html`));
  await Bun.write(`${out}/style.css`, Bun.file(`${import.meta.dir}/style.css`));
  await Bun.write(
    `${out}/manifest.json`,
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Remote Tab",
        version: "2.0.0",
        minimum_chrome_version: "125",
        description:
          "Share one tab with your agent. You control the mode, site scope, and when sharing stops.",
        permissions: ["tabs", "scripting", "storage", "debugger"],
        host_permissions: [`${configuredOrigin}/*`],
        background: { service_worker: "worker.js", type: "module" },
        action: { default_popup: "popup.html" },
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
      },
      null,
      2,
    )}\n`,
  );
  return out;
}
if (import.meta.main) console.log(await buildExtension());
