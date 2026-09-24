import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFile(join(root, path), "utf8");
const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "");
const { version } = JSON.parse(await read("npm/remote-tab/package.json")) as { version: string };
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("npm/remote-tab version must be x.y.z");
// The server replaces this origin with REMOTE_TAB_PUBLIC_ORIGIN when configured.
const origin = "https://your-relay.example";
const design = withoutFrontmatter(await read("docs/design.md"));
const wanted = new Set([1, 4, 5, 6, 10, 11]);
const sections = design.split(/(?=^## \d+\. )/m).filter((section) => {
  const number = /^## (\d+)\./.exec(section)?.[1];
  return number !== undefined && wanted.has(Number(number));
});
const quickStart = `# remote-tab agent quick-start

A person shares one tab of their own Chrome with you through the Remote Tab
extension. Use the official \`remote-tab\` npm package (Node.js 20 or newer).
**The CLI is preferred.** Do not hand-roll the protocol documented further down
unless no package can run in your environment.

Before you create a session, read the agent skill. It holds the consent and
private-delivery rules: \`npx -y remote-tab@${version} skill\`. For more
information (the skill, MCP setup, self-hosting, and the design), see the
repository: https://github.com/BeanOS-ai/remote-tab

## CLI (preferred)

\`\`\`sh
export REMOTE_TAB_SERVER_URL=${origin}
STATE="$(mktemp -d)/session.json"
npx -y remote-tab@${version} create --state "$STATE" --ttl 1800
\`\`\`

The create result contains a secret \`code\`. Deliver it only to the person, over
a private channel. Ask them to paste it into the Remote Tab extension, pick the
tab, mode and scope, and press Share. Then:

\`\`\`sh
npx -y remote-tab@${version} wait-ready --state "$STATE" --timeout-ms 120000
npx -y remote-tab@${version} browser_snapshot --state "$STATE"
npx -y remote-tab@${version} browser_click --state "$STATE" --args '{"ref":"e1"}'
npx -y remote-tab@${version} stop --state "$STATE"
\`\`\`

\`npx -y remote-tab@${version} --help\` lists every command. Output is JSON on
stdout. Errors are JSON on stderr with a nonzero exit code.

## MCP

\`\`\`json
{"mcpServers":{"remote-tab":{"command":"npx","args":["-y","-p","remote-tab@${version}","remote-tab-mcp"],"env":{"REMOTE_TAB_SERVER_URL":"${origin}"}}}}
\`\`\`

## Protocol reference

The rest of this page documents the wire protocol, for clients that cannot run
the package.
`;
const docs = [
  quickStart,
  withoutFrontmatter(await read("docs/agent-api.md")),
  `\n\`\`\`json\n${await read("docs/crypto-vector.json")}\`\`\`\n`,
  ...sections,
].join("\n");
if (Buffer.byteLength(docs) > 44_000) throw new Error("agent docs exceed 44,000 bytes");
const out = join(root, "packages/server/src/generated/bootstrap.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify({ docs, version })}\n`);
console.log(`Agent docs ${Buffer.byteLength(docs)} bytes; quick start uses remote-tab@${version}`);
