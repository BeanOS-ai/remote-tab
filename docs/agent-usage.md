---
created: 2026-09-23
last_updated: 2026-09-23
last_reviewed: 2026-09-23
---

# Agent usage

For wire requests, see [Agent API](agent-api.md). For copyable host configuration, see [examples](../examples/).

## Client library

```ts
import { createSession } from "@remote-tab/client";

const { code, session } = await createSession({
  serverUrl: process.env.REMOTE_TAB_SERVER_URL!,
  apiKey: process.env.REMOTE_TAB_API_KEY, // optional
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
mode/scope checks, redaction, or the consent UI; the installed extension implements those.

## MCP server

After installing the workspace dependencies, launch the stdio server with
`bun packages/mcp/src/main.ts` (the package binary is `remote-tab-mcp`). Set
`REMOTE_TAB_SERVER_URL` in the process environment; `REMOTE_TAB_API_KEY` is optional.
Configure the same command and environment in your MCP host. Standard output
is reserved for MCP messages.

Call `remote_tab_create`, deliver its code privately to the intended human,
then call `remote_tab_wait_ready`. The server exposes every tool in design
§6, including `browser_snapshot`, `browser_click`, screenshots, handoff,
status, and stop. Tool descriptions identify page content as untrusted data.
One MCP process holds one current session; stop it before creating another.
Status includes transport state, expiry and sequence, plus the authenticated
hello's mode/scope when available. The MCP/CLI transport-status adapters do not
query live human-pause state; the extension popup shows it, and queued browser
commands receive `paused` after the human presses Pause.

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
that rendering belongs in the installed extension interaction summary page.
That page now exports a ZIP and renders a GIF locally; CLI rendering itself remains unimplemented.

