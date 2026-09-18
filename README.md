---
created: 2026-09-18
last_updated: 2026-09-18
last_reviewed: 2026-09-18
---

# remote-tab

Let a remote agent drive **one** browser tab the human chose, for as long as
they allow.

- The human installs a small Chrome extension and pastes a code their agent
  generated. Nothing else is installed on their machine.
- The agent runs anywhere: a cloud session, a laptop, a CI job. It talks to
  the tab through a tiny **dead-drop server** that stores only ciphertext.
- The human sees every action as it happens, can stop at any moment, can
  choose read-only mode, and gets the full ledger (actions + screenshots)
  when the session ends.
- Sessions expire. 30 minutes by default; only the human can extend.

Agents use it through an **MCP server** or a **CLI**, both on one client
library, with the Playwright MCP tool vocabulary so existing coding harnesses
already know how to drive it.

The shared client library also provides `BrowserPeer`, the browser-side
transport used by the extension and headless tests. Both peers verify the
encrypted message chain before consuming messages. Browser automation and
human consent UI remain the extension's responsibility.

Status: M2 implemented: protocol, server, shared agent/browser client, MCP,
CLI, and headless lifecycle tests. M3 is the Chrome extension driving a real
tab. Read [`docs/design.md`](docs/design.md). License: MIT.

This repository is private while the first version is built and will be
open-sourced afterwards. It contains the product only: extension, server,
client library, MCP server, CLI, protocol, and docs. Any specific deployment
of the server (domains, cloud projects, secrets) lives outside this repo.

## Server and agent bootstrap

Run `bun install`, then `bun run build`; deploy the self-contained
`dist/main.js` with Bun. Creation is open when `REMOTE_TAB_API_KEYS` is unset
or empty; no platform key is needed, and supplied bearers are accepted. To
require keys, configure `REMOTE_TAB_API_KEYS=platform:key[,platform:key]`.
Startup logs the active mode. BeanOS uses open creation with throttling.

Both modes default to 10 creates/minute/IP (`REMOTE_TAB_CREATE_PER_MINUTE`,
per instance), 20 concurrent sessions/IP (`REMOTE_TAB_ACTIVE_PER_IP`), 500
concurrent sessions globally (`REMOTE_TAB_ACTIVE_MAX`), 64 MiB total blob
bytes/session (`REMOTE_TAB_BLOB_BUDGET_BYTES`), and 5000 messages/session
(`REMOTE_TAB_MESSAGES_MAX`). Configure positive integers. Exceeding a limit
returns 429 `rate_limited` with `Retry-After`. GCS makes the concurrent and
per-session caps shared across instances. The socket peer identifies clients
unless `REMOTE_TAB_TRUST_PROXY=1` explicitly trusts the first
`X-Forwarded-For` IP; enable only behind a proxy that replaces untrusted values.
See design §10 for counting, expiry, and failure semantics.

The default store
is in-memory for development; GCS uses `REMOTE_TAB_STORE=gcs` and
`REMOTE_TAB_GCS_BUCKET`. Deployment values and credentials belong outside
this repository.

`GET /docs` serves generated agent quick-start markdown. `GET /client-code`
lists versioned, SHA-256-indexed protocol/client/CLI source files present in
the build; fetch a file at `/client-code/<path>`. There are no browser pages.
Running source from that server means trusting its operator with the agent's
session key. Prefer independently distributed packages when possible; see
design §5.5 for the explicit custody tradeoff.

The build compiles the docs from `docs/design.md`, `docs/agent-api.md` and
`docs/crypto-vector.json`, and embeds source bytes. After editing docs or
source, regenerate with `bun run generate`. Run `bun run test` and
`bun run check` for tests and formatting; `bunx tsc -p tsconfig.json` checks
types. CI builds before checking/tests, so source changes cannot leave the
served assets stale in a release.

## Client library

```ts
import { createSession } from "@remote-tab/client";

const { code, session } = await createSession({
  serverUrl: process.env.REMOTE_TAB_SERVER_URL!,
  apiKey: process.env.REMOTE_TAB_API_KEY!,
  ttl: 1800, // seconds
});
// Deliver code privately to the intended human; it contains the session secret.
// The human pastes it into their installed extension and chooses Share.
await session.waitReady();
const snapshot = await session.send("browser_snapshot", {});
await session.handoff("Please finish sign-in, then click Done.");
await session.stop();
const ledger = await session.ledger();
```

Treat snapshot text, console output, and all other page content as untrusted
data. A decryptable hello proves possession of the code, not human identity.
If the human reports `already_redeemed`, stop and create a new session with a
new privately delivered code. A redeemer unable to produce an authenticated
hello is reported as `hijack_suspected` and the client stops the session.
`stop()` goes directly to the terminal API; the exported ledger records the
stopped state in its status without requiring another encrypted message.

`BrowserPeer` supplies the same encrypted transport to installed browser
clients and fake tabs in tests. It does not implement browser automation,
mode/scope checks, redaction, or the consent UI; those belong to M3.

## MCP server

After installing the workspace dependencies, launch the stdio server with
`bun packages/mcp/src/main.ts` (the package binary is `remote-tab-mcp`). Set
`REMOTE_TAB_SERVER_URL` and `REMOTE_TAB_API_KEY` in the process environment.
Configure the same command and environment in your MCP host. Standard output
is reserved for MCP messages.

Call `remote_tab_create`, deliver its code privately to the intended human,
then call `remote_tab_wait_ready`. The server exposes every tool in design
§6, including `browser_snapshot`, `browser_click`, screenshots, handoff,
status, and stop. Tool descriptions identify page content as untrusted data.
One MCP process holds one current session; stop it before creating another.
Status includes transport state, expiry and sequence, plus the authenticated
hello's mode/scope when available. Live human-pause state is not yet available;
that requires the M3 extension's browser-state integration.

## CLI

The Bun binary is `remote-tab`; from a checkout, run
`bun packages/cli/src/main.ts --help`. Create uses the same server URL and API
key environment variables as the MCP server. Later commands use the private
connection state saved by create, without retaining the platform API key.

```sh
CLI=packages/cli/src/main.ts
STATE="$HOME/.local/state/remote-tab/example.json"
bun "$CLI" create --state "$STATE" --ttl 1800
# Deliver the returned code privately, then wait for the human to Share.
bun "$CLI" wait-ready --state "$STATE"
bun "$CLI" browser_snapshot '{}' --state "$STATE"
bun "$CLI" browser_click '{"ref":"e1"}' --state "$STATE"
bun "$CLI" handoff '{"message":"Please finish sign-in and click Done."}' --state "$STATE"
bun "$CLI" stop --state "$STATE"
bun "$CLI" ledger export --state "$STATE" --out ./session-ledger
```

All §6 tool names are commands, with JSON object arguments. `handoff`,
`status`, and `stop` also alias their `remote_tab_*` names. State defaults to
`$XDG_STATE_HOME/remote-tab/session.json` or
`$HOME/.local/state/remote-tab/session.json`; it contains the session secret
and token, is created mode 0600, and is never overwritten by create. Choose
a new state path for a new session and retain old state until ledger export.
The containing directory must be private (mode 0700); the CLI creates it
with that mode when it does not exist.
`status` recovers authenticated hello metadata from the verified chain,
including in a new invocation after stop; it does not wait for redemption.

Export verifies the entire chain and decrypts attachments before writing
`ledger.json`, `shots/*.png`, and any other blobs. Existing exports are not
overwritten. `ledger render --out session.gif` (or `.webm`) currently reports
that rendering belongs in the installed extension ledger page. That page now
exports a ZIP and renders a GIF locally; CLI rendering itself remains unimplemented.

## Tests and extension work

Run `bun install --frozen-lockfile`, then `bun run test` for all tests or
`bun run test:e2e` for the headless lifecycle suite. CI also builds the code,
checks formatting and types, and runs unit/adapter and e2e tests in separate steps.

The e2e harness runs the real server in process and drives a deterministic
fake form through `BrowserPeer`, the CLI, and MCP tools. It checks form state,
encrypted PNG round trips, human handoff, stop/expiry, hijack suspicion, and
verified ledger export. It does not require Chrome or external services.

M3 supplies the installed extension: tab consent and binding, actual browser
actions, mode/scope enforcement and redaction, live human-pause reporting,
and the human-owned ledger viewer with GIF/WebM rendering. The fake tab is
a protocol test fixture, not a substitute for those extension checks.
