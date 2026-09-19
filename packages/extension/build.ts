import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import metadata from "./package.json";

export const EXTENSION_VERSION = metadata.version;
const icons = { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" };
const staticFiles = [
  ["popup.html", "popup.html"],
  ["style.css", "style.css"],
  ["bean-creature.svg", "bean-creature.svg"],
  ["ledger.html", "ledger.html"],
  ["ledger.css", "ledger.css"],
  ...Object.values(icons).map((file) => [file, file]),
  ["../../LICENSE", "LICENSE"],
  ["src/vendor/PSL-LICENSE", "vendor/PSL-LICENSE"],
  ["src/vendor/README.md", "vendor/README.md"],
  ["src/vendor/public-suffix-rules.json", "vendor/public-suffix-rules.json"],
] as const;
/** Store archives contain only these built runtime files, icons, and license sources. */
export const STORE_FILES = [
  "manifest.json",
  "worker.js",
  "popup.js",
  "ledger.js",
  ...staticFiles.map(([, target]) => target),
].sort();

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
    entrypoints: ["worker", "popup", "ledger"].map((name) => `${import.meta.dir}/src/${name}.ts`),
    outdir: out,
    target: "browser",
    format: "esm",
    minify: true,
    define: { REMOTE_TAB_SERVER_ORIGIN: JSON.stringify(configuredOrigin) },
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  for (const [source, target] of staticFiles)
    await Bun.write(`${out}/${target}`, Bun.file(`${import.meta.dir}/${source}`));
  await Bun.write(
    `${out}/manifest.json`,
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Remote Tab",
        short_name: "Remote Tab",
        version: EXTENSION_VERSION,
        minimum_chrome_version: "125",
        description:
          "Share one tab with your agent. You control the mode, site scope, and when sharing stops.",
        permissions: ["tabs", "debugger", "notifications"],
        host_permissions: [`${configuredOrigin}/*`],
        background: { service_worker: "worker.js", type: "module" },
        action: { default_popup: "popup.html", default_icon: icons },
        icons,
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
      },
      null,
      2,
    )}\n`,
  );
  return out;
}
if (import.meta.main) console.log(await buildExtension());
