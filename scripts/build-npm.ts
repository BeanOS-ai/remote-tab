import { chmod, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Builds the publishable `remote-tab` npm package: Node bundles of the CLI and
// the MCP server. Workspace packages are bundled in; the package's declared
// dependencies stay external and are installed by npm at their pinned versions.
const root = resolve(import.meta.dir, "..");
const pkg = join(root, "npm/remote-tab");
const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
};
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("npm version must be x.y.z");
const external = Object.keys(manifest.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);
await rm(join(pkg, "dist"), { recursive: true, force: true });
for (const [name, entry] of [
  ["cli", "packages/cli/src/main.ts"],
  ["mcp", "packages/mcp/src/main.ts"],
] as const) {
  const build = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(pkg, "dist"),
    naming: `${name}.js`,
    target: "node",
    format: "esm",
    external,
  });
  if (!build.success) throw new AggregateError(build.logs, `npm build failed: ${name}`);
  const file = join(pkg, "dist", `${name}.js`);
  // Drop the source shebang and the Bun pragma it triggers; the package runs on Node.
  const code = (await readFile(file, "utf8")).replace(/^#!.*\n(\/\/ @bun\n)?/, "");
  if (/\bBun\./.test(code)) throw new Error(`${name} bundle uses a Bun-only API`);
  await writeFile(file, `#!/usr/bin/env node\n${code}`);
  await chmod(file, 0o755);
}
await copyFile(join(root, "LICENSE"), join(pkg, "LICENSE"));
await copyFile(join(root, "skills/remote-tab/SKILL.md"), join(pkg, "SKILL.md"));
console.log(`Built remote-tab ${manifest.version} in npm/remote-tab/dist`);
