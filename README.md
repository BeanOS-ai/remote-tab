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

The pasted code is `rt1.` plus a 22-character base64url secret (26 characters
altogether). The client creates a fresh 128-bit secret and derives the session
id locally before creating it on the server. The extension derives the same
id; the secret never goes to the server. Old three-part codes are rejected.

Status: M1–M3 implemented: protocol, server, shared agent/browser client,
MCP, CLI, and the Chrome extension with human controls, privacy enforcement,
verified ledger export, and store packaging. BeanOS cutover (M4) and public
release (M5) remain. Read [`docs/design.md`](docs/design.md). License: MIT.

This repository is private while the first version is built and will be
open-sourced afterwards. It contains the product only: extension, server,
client library, MCP server, CLI, protocol, and docs. Any specific deployment
of the server (domains, cloud projects, secrets) lives outside this repo.

## Server and agent bootstrap

Use **Bun 1.4.2**, the pinned CI and container build baseline. The committed v2
lockfile is incompatible with Bun 1.3.13 frozen installs; do not rewrite it or
disable `--frozen-lockfile` to accommodate an older build image. Newer versions
require validation before updating the build pin.

Run `bun install --frozen-lockfile`, then `bun run build`; deploy `dist/main.js` with Bun.
The API is key-optional: anonymous calls default to 10 requests/second/IP.
Present a platform key with `Authorization: Bearer <key>` on creation or
bootstrap requests for the operator's resolved QPS. Session requests keep
agent/browser bearer tokens; they inherit the creator's key identity without
resending its platform key. Set anonymous QPS to 0 to require keys. A supplied
invalid key is always refused, never silently treated as anonymous.

Operators can use static keys or an external key service. Static entries are
`platform:key[:qps]` (default 10 QPS, subject `platform`, tier `static`). If a
legacy key contains colons and ends with a number, append an explicit QPS to
preserve that key: `platform:key:123:10` keeps raw key `key:123`. HTTP resolution
sends only SHA-256 of the key to `<base>/resolve?key=<hash>` with the service
bearer token and expects `{tier,qps,subject}` or HTTP 404. Other service errors
fail closed with 503 for keyed traffic; anonymous traffic is unaffected.
Claims cache for 300 seconds (misses: 60), so revocation takes effect after
cached approval expires. A session's subject cannot change on refresh.

Keys and tiers come from whoever operates the server. BeanOS runs its key
service outside this repository; distributions replace this
[key-service placeholder](https://key-service.example) with their own link.
No email, billing, key issuance, or tier product rules are implemented here.

| Environment variable | Default / meaning |
|---|---|
| `REMOTE_TAB_ANONYMOUS_QPS` | `10`; `0` requires keys |
| `REMOTE_TAB_API_KEYS` | Empty; comma-separated `platform:key[:qps]` |
| `REMOTE_TAB_KEY_SERVICE_URL` | Unset; HTTP resolver base URL takes precedence over static keys |
| `REMOTE_TAB_KEY_SERVICE_TOKEN` | Required for HTTP resolver or usage sink; bearer service credential |
| `REMOTE_TAB_KEY_CACHE_SECONDS` | `300`; `0` disables positive caching; maximum `86400` |
| `REMOTE_TAB_USAGE_URL` | Unset: JSON log sink; otherwise full usage POST endpoint |
| `REMOTE_TAB_TRUST_PROXY_HOPS` | Unset; number of trusted hops to skip from the right, including socket peer; `0` uses socket only |
| `REMOTE_TAB_TRUST_PROXY` | Unset; legacy `1` trusts first X-Forwarded-For only behind a proxy that replaces it |
| `REMOTE_TAB_ACTIVE_PER_IP` | `20` concurrent sessions |
| `REMOTE_TAB_ACTIVE_MAX` | `500` concurrent sessions globally |
| `REMOTE_TAB_BLOB_BUDGET_BYTES` | `67108864` uploaded bytes/session |
| `REMOTE_TAB_MESSAGES_MAX` | `5000` messages/session |
| `REMOTE_TAB_STORE` | `memory`; optional `gcp` uses Firestore + GCS blobs |
| `REMOTE_TAB_GCS_BUCKET` | Required for `gcp`; ciphertext blobs only |
| `REMOTE_TAB_FIRESTORE_DATABASE` | `(default)`; Firestore database for `gcp` |
| `PORT` | `8080` |

QPS values are nonnegative integers; keyed QPS 0 is unlimited. The pinned
`rate-limiter-flexible` memory backend counts every API call, including
long-poll and bootstrap calls, in one-second subject/IP windows. Several keys
for one subject share its counter. Limits are per instance; a shared backend
can be substituted through the same library. Quota changes retain the current
counter. Exceeding a limit returns 429 `rate_limited` with `Retry-After`;
clients wait only within their operation deadline and cancellation signal.
This replaces `REMOTE_TAB_CREATE_PER_MINUTE`. Lifetime message/blob and active
session caps remain; reads and Stop remain possible at lifetime caps, subject
to request limits and key validity.

Usage consists only of subject or IP, opaque tier, kind, amount, and timestamp.
The default sink aggregates by minute/identity/tier/kind and logs JSON. The HTTP
sink sends bounded bare JSON arrays (at most 100 events/32 KiB) asynchronously
with the service bearer, without retrying ambiguous POST failures. Queues and
transport timeouts are bounded; reporting failures never fail API requests.
HTTP key/usage service URLs require HTTPS, with HTTP allowed for loopback tests.

Use the socket IP by default. For an appending trusted proxy chain, configure
`REMOTE_TAB_TRUST_PROXY_HOPS`; e.g. 2 selects the second address from the right
in X-Forwarded-For after treating the socket as the final trusted hop. Restrict
ingress to that exact chain. Invalid/short chains fall back to the socket.
The legacy first-value mode is unsuitable for proxies that retain a caller's
forwarded prefix. Deployment credentials and values belong outside this repository.

The default memory store needs no cloud services and loses sessions on restart.
For shared durable storage, select `REMOTE_TAB_STORE=gcp`, set the bucket/database,
and provide Application Default Credentials (including attached-service-account
metadata credentials on GCP). The optional `@remote-tab/store-gcp` workspace
package uses Firestore for sessions/messages and GCS for blobs only. Memory mode
never initializes cloud clients. The built server leaves the adapter external:
retain/install the adapter package with its dependencies when packaging GCP mode.
Unknown selectors, including the retired `gcs`, fail startup.

Firestore transactions enforce chain order, lifetime budgets, and shared active
caps; long-poll uses snapshot listeners. GCP caps support at most 1,000 configured
global sessions. Memory caps are local; request QPS remains per instance in both
modes. Enable TTL on `delete_at` in both `sessions` and `messages` collection groups,
exempt large ciphertext/admission fields from indexing, and configure blob
lifecycle with `daysSinceCustomTime: 1` on `sessions/`. Session TTL is expiry +24h;
children use session creation +60min +24h, covering Extend without bulk rewrites.
Cleanup is asynchronous; soft-delete/backup policies may retain data longer.

See the [GCP store contract](docs/store-gcp.md) for layout, IAM, retention, and
emulator validation. Migration requires draining the old GCS cursor deployment;
there is no dual-read compatibility or live migration. Self-hosters may supply
other implementations of the exported `Store` interface.

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
commands receive `paused` while the human has taken over.

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

## Tests and extension

Run `bun install --frozen-lockfile`, then `bun run test` for all tests or
`bun run test:e2e` for the headless lifecycle suite. CI also builds the code,
checks formatting and types, and runs unit/adapter and e2e tests in separate steps.

The e2e harness runs the real server in process and drives a deterministic
fake form through `BrowserPeer`, the CLI, and MCP tools. It checks form state,
encrypted PNG round trips, human handoff, stop/expiry, hijack suspicion, and
verified ledger export. It does not require Chrome or external services.

The installed extension adds tab consent and binding, actual browser actions,
mode/scope enforcement, redaction, human-pause controls, and the local ledger
viewer with GIF rendering. Extension tests run its real driver loop against
fake CDP; optional Chromium smoke scripts cover browser behavior, UI, media,
and the packaged extension. See [verification instructions](packages/extension/README.md).

## Self-hosting and extension distribution

Build and run the server with Bun as described above. Put the API behind your
own HTTPS origin; choose the store and creation/auth limits in your deployment
configuration. Keep credentials outside this checkout. `/docs` provides the
agent bootstrap; the server never hosts a consent or ledger page.

The installed extension must be built for that same origin. From a clean
checkout with Bun, Python 3, and workspace dependencies installed:

```sh
REMOTE_TAB_SERVER_ORIGIN=https://tabs.example.org \
  packages/extension/package-store.sh /tmp/bean-tab-share-2.0.1.zip
```

The release packager requires an explicit HTTPS origin and rejects the default
placeholder. It builds from source into a temporary directory, then includes
only the manifest, local runtime/assets, and license notices. The manifest's
host permission and worker configuration derive from the same setting. No
server address, credential, or deployment configuration is committed here.

For development, `bun packages/extension/build.ts` writes `dist/extension` for
Chrome's **Load unpacked**. Its default `https://remote-tab.example` is a
placeholder; HTTP loopback origins are permitted only for development builds.
Store uploads and publishing are separate distribution actions. Version 2.0.1
retains the existing **Bean Tab Share** listing name; a public-store rename is
an M5 decision. See [extension usage](packages/extension/README.md) for consent,
controls, privacy behavior, and local ledger export.

The generic 2.0.1 build accepts only `rt1.` codes. Supporting the legacy 1.1.2
short-key/pointer flow requires deployment-owned GCS/paste-bin origins, so that
one-release compatibility shim belongs in the BeanOS distribution during M4.
It is intentionally absent here and must be removed from that distribution in
2.1. The generic host permission remains exactly the configured server origin.
