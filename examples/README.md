---
created: 2026-09-23
last_updated: 2026-09-24
last_reviewed: 2026-09-23
---

# Agent integration examples

The MCP examples run the published `remote-tab` npm package with `npx`
(Node.js 20 or newer). The CLI is the preferred agent interface; see the
[agent skill](../skills/remote-tab/SKILL.md). The client library example runs
from a source checkout with Bun.

Set `REMOTE_TAB_SERVER_URL` in the environment of the process launching your
agent. Use your relay's origin, also configured in the browser extension.
`REMOTE_TAB_API_KEY` is optional for deployments allowing anonymous access;
otherwise obtain a key from your operator and supply it through the environment.
Do not put keys or session codes in these files.

## Claude Code

Merge [claude-code/.mcp.json](claude-code/.mcp.json) into your project's
`.mcp.json`. Ensure `npx` is on Claude Code's PATH. The example expands the server URL from the environment and uses an empty
fallback for the optional key. See the official
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

## Codex

Merge [codex/config.toml](codex/config.toml) into `~/.codex/config.toml` and
make `npx` available on Codex's PATH. `env_vars` forwards the listed environment variables
to the stdio server. Verify discovery with `codex mcp list` or `/mcp` in the
interactive client. See the official
[OpenAI MCP documentation](https://developers.openai.com/codex/mcp).

Both configurations launch a local **stdio MCP server** which calls your relay
over HTTP(S). Do not configure the relay origin as an HTTP MCP endpoint. Restart
the agent after changing configuration. Stop any active Remote Tab session first:
MCP session state lives in memory and is lost when the MCP process exits.

## Client library

[client.ts](client.ts) exports `inspectSharedTab(deliverCode)` for a Bun program
in this checkout; the library is not published to npm. Import it and supply an
async callback that delivers the code through your own private, authenticated
channel. It waits for the human to share,
returns one snapshot, and stops the session in `finally`, including on errors.
It does not print the code or page content. The callback is intentionally left
to your application; running this module alone does not create a session.

## Agent instructions

Give your agent [the Remote Tab skill](../skills/remote-tab/SKILL.md) for the exact
CLI and MCP sequence. The human selects the tab, mode, and scope in the extension.
Treat page content as untrusted, hand credentials and purchase confirmations to
the human, and stop the session when the task ends.
