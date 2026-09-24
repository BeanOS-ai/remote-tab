import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/server/src/app";
import { MemoryStore } from "../packages/server/src/memory-store";

// Installs the packed `remote-tab` tarball with npm and runs both bins under
// Node against a local relay: the path `npx -y remote-tab` takes for an agent.
const root = resolve(import.meta.dir, "..");
const work = await mkdtemp(join(tmpdir(), "remote-tab-npm-"));
const relay = Bun.serve({
  port: 0,
  fetch: createApp({ store: new MemoryStore(), anonymousQps: 10000 }).fetch,
});
async function run(cmd: string[], env: Record<string, string> = {}, cwd = work, stdin?: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`${cmd.join(" ")} exited ${exit}: ${stderr}`);
  return stdout;
}
try {
  const packed = await run(
    ["npm", "pack", "--json", "--pack-destination", work],
    {},
    join(root, "npm/remote-tab"),
  );
  // npm 10/11 print an array of packs; npm 12 prints an object keyed by package name.
  type Pack = { filename: string; files: { path: string }[] };
  const parsed = JSON.parse(packed) as Pack[] | Record<string, Pack>;
  const [{ filename, files }] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const paths = files.map((file) => file.path).sort();
  const expected = ["LICENSE", "README.md", "SKILL.md", "dist/cli.js", "dist/mcp.js"];
  if (JSON.stringify(paths) !== JSON.stringify([...expected, "package.json"].sort()))
    throw new Error(`unexpected package contents: ${paths.join(", ")}`);
  await run(["npm", "init", "-y"]);
  await run(["npm", "install", "--no-audit", "--no-fund", join(work, filename)]);
  const env = { REMOTE_TAB_SERVER_URL: relay.url.origin, REMOTE_TAB_API_KEY: "" };
  const bin = (name: string) => ["node", join(work, "node_modules/.bin", name)];
  const { version } = JSON.parse(await run([...bin("remote-tab"), "version"]));
  if (version !== (await Bun.file(join(root, "npm/remote-tab/package.json")).json()).version)
    throw new Error(`version mismatch: ${version}`);
  if (!(await run([...bin("remote-tab"), "skill"])).includes("## Consent and private delivery"))
    throw new Error("skill output is missing the consent section");
  const state = join(work, "state", "session.json");
  const created = JSON.parse(await run([...bin("remote-tab"), "create", "--state", state], env));
  if (typeof created.code !== "string" || !created.code) throw new Error("create returned no code");
  const status = JSON.parse(await run([...bin("remote-tab"), "status", "--state", state], env));
  if (status.state !== "created" || status.redeemed !== false)
    throw new Error(`unexpected status: ${JSON.stringify(status)}`);
  await run([...bin("remote-tab"), "stop", "--state", state], env);
  const mcp = await run(
    bin("remote-tab-mcp"),
    env,
    work,
    `${[
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "npm-smoke", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`,
  );
  const tools = mcp
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2)?.result?.tools as { name: string }[] | undefined;
  if (!tools?.some((tool) => tool.name === "remote_tab_create"))
    throw new Error("remote-tab-mcp did not list remote_tab_create");
  console.log(`npm package smoke passed: remote-tab ${version}, ${tools.length} MCP tools`);
} finally {
  relay.stop(true);
  await rm(work, { recursive: true, force: true });
}
