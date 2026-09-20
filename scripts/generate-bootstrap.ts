import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFile(join(root, path), "utf8");
const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "");
const design = withoutFrontmatter(await read("docs/design.md"));
const wanted = new Set([1, 4, 5, 6, 10, 11]);
const sections = design.split(/(?=^## \d+\. )/m).filter((section) => {
  const number = /^## (\d+)\./.exec(section)?.[1];
  return number !== undefined && wanted.has(Number(number));
});
const docs = [
  "# remote-tab agent quick-start\n\nGenerated from the repository documentation at build time.\n",
  withoutFrontmatter(await read("docs/agent-api.md")),
  `\n\`\`\`json\n${await read("docs/crypto-vector.json")}\`\`\`\n`,
  ...sections,
].join("\n");
if (Buffer.byteLength(docs) > 44_000) throw new Error("agent docs exceed 44,000 bytes");
const { version } = JSON.parse(await read("package.json")) as { version: string };
const files: { path: string; sha256: string; bytes: number }[] = [];
const sources: Record<string, string> = {};
async function add(path: string) {
  const text = await read(path);
  const bytes = Buffer.from(text);
  sources[path] = text;
  files.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
async function walk(path: string) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules") await walk(`${path}/${entry.name}`);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/\.(test|spec)\.ts$/.test(entry.name)
    ) {
      await add(`${path}/${entry.name}`);
    }
  }
}
for (const name of ["protocol", "client", "cli"]) {
  const path = `packages/${name}`;
  const manifest = await read(`${path}/package.json`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (manifest === null) continue;
  if (JSON.parse(manifest).version !== version) throw new Error(`version mismatch: ${path}`);
  await add(`${path}/package.json`);
  await walk(`${path}/src`);
}
files.sort((a, b) => a.path.localeCompare(b.path));
const out = join(root, "packages/server/src/generated/bootstrap.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify({ docs, index: { version, files }, sources })}\n`);
console.log(`Embedded ${files.length} agent files; docs ${Buffer.byteLength(docs)} bytes`);
