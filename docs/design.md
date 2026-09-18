---
created: 2026-09-18
last_updated: 2026-09-18
last_reviewed: 2026-09-18
---

# remote-tab — design

Status: **approved design; M2 implemented, M3 extension next**. Decisions recorded here were made by Gilad on
2026-09-18; the open questions at the end are the ones still his to make.
License: MIT (decided 2026-09-18).
Lineage: BeanOS "tab-share" (monorepo `deployments/beanhome/docs/tab-share.md`,
extension "Bean Tab Share" 1.1.2, skill `beanos-tab-share`). remote-tab is the
productised successor; the trust model is inherited, the transport is
redesigned.

## 1. One paragraph

A human opens a normal Chrome tab, opens the remote-tab extension, pastes a
short code their agent produced, picks a mode (read-only / act / full) and
optionally "this site only", and clicks **Share**. From then until the human
clicks **Stop** or the TTL expires, the agent can read the tab (accessibility
snapshot, screenshots, console, network) and, in act mode, click, type, and
navigate. Every command and result passes through a small server that holds
only ciphertext, and every action is screenshotted and appended to a
hash-chained ledger the human owns. When the agent hits something only the
human should do (MFA, captcha, payment), it asks for a **handoff**: the human
does that step and hands control back.

## 2. Goals and non-goals

Goals (v1):

- Zero install beyond the extension. Zero accounts for the human.
- Agent location does not matter. Only outbound HTTPS is required.
- Human in control: visible actions, one-click stop, read-only mode, origin
  scope, human-only TTL extension, "your turn" handoff.
- Blind server when both endpoints use independently trusted client code.
  The operator cannot read commands, results, or screenshots under that
  assumption; server-fetched agent code is the explicit exception (§5.5).
- Ledger delivered to the human. Hash-chained, exportable, renderable to a
  GIF/video from the same session key.
- Agents drive it through MCP **and** a CLI, sharing one client library, with
  the Playwright MCP tool vocabulary.
- Minimal code. Reuse existing vocabulary and browser APIs; do not build a
  browser automation framework.

Non-goals (v1), explicitly deferred:

- Replaying a past session as automation ("do this again next month").
- Enterprise policy (admin origin allowlists, SSO-bound consent, SIEM export).
- Livestream link for third-party viewers. Designed for (see §12), not built.
- Multi-tab or whole-window sharing. One tab. Re-sharing a new tab is fast.
- Mobile browsers.
- A low-latency relay (WebSocket/WebRTC). The dead-drop is fast enough for
  LLM-paced work; §5.4 describes the upgrade path without changing trust.

## 3. Roles

| Role | Runs | Holds |
|---|---|---|
| **Human** | Chrome + remote-tab extension | the session secret (from the pasted code) |
| **Agent** | anywhere (via client lib → MCP or CLI) | the session secret + an agent token |
| **Server** | any host of this repo's server (BeanOS runs one; self-hostable) | ciphertext, sequence numbers, tokens; **never the secret with independently trusted clients** (§5.5) |
| **Store** | Google Cloud Storage behind the server | ciphertext objects with a TTL lifecycle |

## 4. Session lifecycle

1. **Create.** Agent → `POST /v1/sessions`, with a platform API key only
   when the operator requires one (§5.3). Server
   returns `{id, agent_token, expires_at}`. Server-side there is no plaintext
   yet and never will be.
2. **Code.** The client library generates a random 256-bit **secret** locally
   and prints the **code** the human pastes:
   `rt1.<session-id>.<base64url(secret)>`. The secret never reaches the
   server: the extension sends only the session id when it redeems. The agent
   hands the code to the human on a private channel; **the code is a bearer
   capability and private delivery is the trust assumption** (§11). There is
   no clickable link form in v1: a link would land on a web page, and any page
   that can read the secret is a client that must be trusted with it (§5.5).
3. **Redeem.** Extension → `POST /v1/sessions/{id}/redeem` with only the
   session id. One-shot: the first redeem wins and returns `browser_token`;
   any later redeem is refused. Redeem window: 10 minutes from create.
4. **Hello.** Extension posts an encrypted `hello` message (mode, origin
   scope, tab title/URL, extension version). The agent decrypts it. Hello
   proves that the redeemer holds the secret; it does not prove who they are.
   Two cases, kept distinct:
   - **Only the session id leaked** (for example, it appeared in a server log
     or a URL). A redeemer without the secret cannot produce a hello the agent
     can decrypt. The agent stops the session and tells its user. The human,
     when they paste the real code, sees "already redeemed" and knows too.
   - **The complete code leaked** before the human redeemed it. The thief
     holds the secret, wins the one-shot redeem, and can impersonate the
     browser and read the agent's commands. Hello cannot detect this. The
     defences are the private channel, the short redeem window, and the human
     seeing "already redeemed" and telling the agent, which then stops the
     session. §11 states this plainly; nothing downstream may assume more.
5. **Drive.** Agent posts encrypted commands; extension executes, screenshots,
   posts encrypted results. Both sides long-poll for new sequence numbers.
6. **Handoff.** Agent posts `handoff {message}`; the extension shows a banner
   ("the agent needs you to sign in / approve / solve this"), pauses agent
   commands, and the human clicks **Done** to resume. The agent is blocked on
   the `handoff_done` message.
7. **Stop.** Either side posts `stop`. The extension detaches immediately. The
   server refuses further commands. Stop cannot be undone; re-share is a new
   session.
8. **Expire.** TTL 30 minutes by default, 60 maximum. Only the extension can
   extend (human clicks **Extend**), and only in 30-minute steps to the max.
9. **Ledger.** After stop/expiry the human opens the ledger **in the
   extension** (an extension page, code shipped with the extension), which
   decrypts locally, verifies the hash chain, and offers JSON + PNG export and
   a GIF/video render. The agent side can do the same through the CLI. The
   server serves no ledger page (§5.5). Objects are deleted by the store's
   lifecycle rule 24 hours after expiry; the export is the durable copy.

## 5. Transport: the dead drop

### 5.1 Why a server at all, and why it stays blind

tab-share used signed GCS URLs as the whole transport. That worked and needed
no server, but the extension had to trust an exact bucket list, the pasted
value was ~880 characters (fixed later by a courier), and no third party could
mint a share. A thin server fixes all three and gives one trust root (a
domain) instead. It is still just a dead drop: it assigns sequence numbers,
checks tokens, and stores blobs. With independently trusted client code, end-to-end encryption means the
server, its operator, and the store see ciphertext only. For that promise to survive a
compromised server, human-side code must come from the installed extension.
Agents may deliberately trust server-supplied bootstrap source (§5.5–5.6);
the server is an API, not a web application.

### 5.2 Crypto (deliberately boring)

- Secret: 32 random bytes, generated by the agent client, carried in the code.
- Keys: `HKDF-SHA256(secret, info="remote-tab/v1/" + session-id)` → one
  AES-256-GCM key. (WebCrypto has AES-GCM natively on both sides.)
- Every message and blob: AES-256-GCM, 96-bit random nonce, AAD =
  `session-id | role | prev_hash` (the sender knows `prev_hash`; the server
  assigns `seq` only after the append). Tampering, replay across sessions, and
  replay at a different chain position all fail to decrypt.
- No ECDH. The code is already delivered on a private channel; a symmetric
  secret is enough and removes a key-exchange round trip.
- Hash chain: each message carries `prev_hash` and the server rejects a
  message whose `prev_hash` is not the hash of the latest stored message for
  that session. `hash = SHA-256(session-id || seq || ciphertext)`. The chain is
  over ciphertext, so the server can enforce it blind, and the client
  verifies it after decrypting.

### 5.3 Server API (v1)

All bodies are JSON unless noted. Authorization is a bearer token: the
optional platform API key for create, `agent_token` or `browser_token` afterwards.
With `REMOTE_TAB_API_KEYS` unset or empty, creation is open, including requests
carrying a bearer. When configured, a matching platform key is required. Both
modes enforce the throttles in §10.
The additional agent bootstrap routes are specified in §5.6; the server
serves no pages (§5.5).

| Method + path | Who | Purpose |
|---|---|---|
| `POST /v1/sessions` | agent (optional API key) | create; `{ttl_seconds?}` → `{id, agent_token, expires_at, redeem_until}` |
| `POST /v1/sessions/{id}/redeem` | browser (no token) | one-shot → `{browser_token, expires_at}` |
| `POST /v1/sessions/{id}/messages` | agent or browser | append `{role, prev_hash, nonce, ciphertext}` → `{seq, hash}` |
| `GET /v1/sessions/{id}/messages?after={seq}&wait=25` | agent or browser | long-poll up to 25 s; returns messages after `seq` |
| `POST /v1/sessions/{id}/blobs` | agent or browser | binary body (ciphertext), ≤ 4 MiB → `{blob_id}` |
| `GET /v1/sessions/{id}/blobs/{blob_id}` | agent or browser | binary |
| `POST /v1/sessions/{id}/extend` | browser only | `+1800 s`, capped at 3600 s total |
| `POST /v1/sessions/{id}/stop` | agent or browser | terminal |
| `GET /v1/sessions/{id}` | agent or browser | `{state, expires_at, last_seq, redeemed}` (no content) |

The server keeps per-session state (tokens as SHA-256 hashes, state, last
seq/hash, expiry) as `sessions/{id}/state.json` and message/blob bodies as
`sessions/{id}/msgs/{uuid}.json` and `sessions/{id}/blobs/{blob_id}`, all in
GCS. Each immutable message object points to its previous committed object.
An append first writes its candidate message, then publishes its pointer and
seq/hash with a generation-matched compare-and-swap on `state.json`. Readers
follow only committed pointers and report missing committed objects as errors.
Failed writes cannot advance the cursor; losing or crashed candidates remain
unreachable until lifecycle cleanup. Reading a page walks the committed suffix
backwards, costing one read per message after the requested sequence even when
the page limit is smaller. Two server instances cannot commit the same `seq`.
A memory store with the same interface serves tests and local development. A bucket
lifecycle rule deletes everything 24 h after `expires_at`. Message size cap
64 KiB; larger payloads (screenshots, DOM dumps) go through blobs and the
message carries the blob id.

### 5.4 Latency and the upgrade path

One round trip is one append plus one long-poll wake-up: well under a second
when the server watches its own store, versus the multi-second polling of
signed-URL tab-share. That is enough for LLM-paced driving. If a use case
needs sub-second interaction (live cursor, streaming a screen), add a
WebSocket lane on the same server that fans out messages in memory *and*
persists them to the store. Nothing about consent, keys, or the ledger
changes; the lane is an optimisation negotiated over the dead drop, and a
client whose lane drops falls back to long-polling silently. WebRTC is
possible for agents with UDP egress but is not worth its ops surface for v1.

### 5.5 Custody rule: no server code in the human's browser

The blind-server promise for the human requires that code handling their
secret comes from the installed extension, never a page served by the
server. A URL fragment keeps a secret out of the HTTP request but not out of
scripts on the page. There is no landing page, code link, ledger viewer, or
browser-executed JavaScript on this server. The extension's Web Store
channel remains the human's client-code trust root.

Serving client source to the **agent** is a deliberate convenience for an
agent with no GitHub or npm access. **An agent that runs code fetched from
the server trusts that server's operator with the complete shared session
key.** The agent's and human's copies are identical, not cryptographic
"halves": compromised agent code can expose commands, browser results, and
screenshots. This gives up the blind-server guarantee against a malicious
operator for the whole session; the human's installed-code boundary does not
change.
An agent that can reach an independent package registry should prefer that
trusted distribution, or compare the served version and SHA-256 file hashes
against the published package. Hashes from the same server check integrity,
not authenticity; an operator can replace both a file and its hash.

The API and the two agent bootstrap surfaces below are the entire public
surface. No HTML and no JavaScript executed by a browser; source files are
plain downloads for agents. Everything else returns 404. Code handoff stays
private; ledger viewing and any future livestream remain installed clients.

### 5.6 Agent bootstrap without GitHub or npm (2026-09-18 addendum)

- `GET /docs` returns `text/markdown; charset=utf-8`: a self-contained agent
  quick-start covering the pasted code, all §5.3 requests and responses,
  crypto serialization and test vectors, §6 tools, handoff, limits, and safe
  private delivery. It includes the §5.5 trust caveat. The build generates
  it from selected sections of this design, `docs/agent-api.md`, and the
  checked crypto vector in `docs/crypto-vector.json`; the build rejects a
  document larger than 40,000 UTF-8 bytes. There is no second hand-maintained
  copy of the quick-start.
- `GET /client-code` returns `{version, files:[{path, sha256, bytes}]}`.
  Paths are repository-relative. `GET /client-code/<path>` returns those
  exact UTF-8 bytes as `text/plain` or `application/typescript`, with
  `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
  Version is the package release version, shared across the exposed packages;
  SHA-256 hashes cover the bytes, not a reserialized representation.
- Build-time generation embeds package manifests and non-test TypeScript
  sources from `packages/protocol`, `packages/client`, and `packages/cli`
  into the server bundle. Only packages present in the build are listed
  (protocol, client, and CLI are implemented in M2). No server source, dependencies,
  node_modules, filesystem lookup at request time, or arbitrary paths.
  All entrypoints build the assets before bundling; source changes are
  included on the next build. Unknown paths and non-GET methods return 404.
- Agents download the index, validate version and hashes against independent
  published packages when possible, save each allowlisted file under its
  path, and run the source with Bun. Until npm publication the hashes only
  detect download corruption: they are not an independent trust anchor.

## 6. Protocol vocabulary

Use the Playwright MCP tool names and argument shapes wherever they exist, so
agents that already know `browser_snapshot` / `browser_click` need no
learning curve. Snapshot returns the accessibility tree with stable `ref`
ids; acting tools target a `ref` from the latest snapshot. Raw CSS selectors
are not part of the vocabulary.

| Tool | Mode | Notes |
|---|---|---|
| `browser_snapshot` | read | a11y tree, refs, URL, title |
| `browser_take_screenshot` | read | PNG blob; optional `ref` to crop |
| `browser_console_messages`, `browser_network_requests` | read | bounded, credential headers redacted |
| `browser_click {ref}`, `browser_type {ref, text, submit?}`, `browser_press_key {key}`, `browser_hover {ref}`, `browser_select_option {ref, values}`, `browser_drag` | act | each acting command auto-captures one screenshot into the ledger |
| `browser_navigate {url}`, `browser_navigate_back` | act | refused outside scope when "this site only" is set |
| `browser_wait_for {text? \| time?}` | act | |
| `browser_evaluate {function}` | full | only in full mode |
| `remote_tab_handoff {message}` | any | "your turn"; blocks until `handoff_done` |
| `remote_tab_status` | any | mode, scope, expiry, paused-by-human, last seq |
| `remote_tab_stop` | any | terminal |

Not offered: tabs, file upload, PDF save, dialogs beyond auto-dismiss with a
reported message. Additions must clear the same bar: an agent needs it for a
real task and it does not widen what the human consented to.

## 7. Extension

Evolves the published **Bean Tab Share** 1.1.2 (same Web Store listing, new
major version) rather than a second listing. Manifest v3; permissions `tabs`,
`scripting`, `storage`, `debugger`; host permission for the server origin only. `REMOTE_TAB_SERVER_ORIGIN` is a
build-time distribution setting, compiled into both the worker and manifest; the
repository default is `https://remote-tab.example`. Chrome 125 or newer is
required for flattened debugger child-frame sessions. The active debugger
session keeps the MV3 service worker alive.
Session secrets stay only in memory. Browser restart or debugger loss ends
local control; there is no automatic resume or command replay. The human
must start a fresh share after a restart. Built artifacts are ignored.

Popup: paste field, mode (read-only / act / full; full is labelled as
scripting access), checkbox **this site only**, **Share this tab**. While
shared: current URL, a live feed of actions in plain words ("clicked
Submit", "typed into Search"), a **Stop** button that is always visible, an
**Extend** button near expiry, the handoff banner with **Done**, and a
**Paused: you took over** state with **Resume**.

Behaviour:

- Reads and screenshots use `chrome.debugger` (CDP) on the shared tab;
  Chrome's "is debugging this browser" bar is expected and the popup says so.
- Every acting command captures one screenshot after it completes. Read
  commands do not.
- **Origin scope** compares eTLD+1 using the bundled Mozilla Public Suffix List
  (including private suffixes; its data license and source accompany the snapshot).
  IP addresses and local hosts are compared exactly. CDP Fetch interception
  blocks out-of-scope document requests, including redirects and link navigation.
  Only HTTP(S) tabs may be shared. A navigation outside scope is blocked,
  reported to the agent as `scope_denied`, and shown to the human.
- **Pause on human input.** Any keyboard or pointer input in the shared tab
  flips the session to paused; queued commands return `paused`; the human
  clicks Resume. Monitoring runs in isolated worlds, including child frames;
  page-script events do not trigger it. Before admitting a loaded document,
  the extension inspects every frame execution world and refuses sharing if
  existing window capture handlers could suppress its listener. Unknown or
  failed inspection ends sharing; pages are never reloaded automatically.
  The monitor also rechecks its own listeners before operations and ends
  sharing if a same-context document replacement removes them.
  Later page listeners cannot run before the installed monitor. Only the exact input events dispatched
  by the current automation call are excluded. An interrupted command returns
  `paused` even if Resume is clicked before it finishes, without uploading its
  result or screenshot. A handoff must be completed with Done, not Resume.
  Diagnostic buffers are cleared on pause and events are not collected while
  paused, so human-entered credentials cannot remain in delayed console/network
  results after a field clears itself. Automation input uses a unique timestamp
  one second ahead to distinguish delayed CDP event delivery; only an exact
  match received before that timestamp is excluded. Page handlers therefore see
  adjusted timestamps for automated input; late events pause safely.
- **Redaction, kept simple.** Values of inputs whose type is `password`, or
  whose `autocomplete` is `one-time-code` or `cc-*`, are never included in
  snapshots or results, and those elements are masked in screenshots. No
  configurable rules in v1. DOM snapshots include closed shadow roots. Known
  sensitive values are scrubbed from outgoing data for the rest of the share;
  the volatile dictionary is bounded and fails closed. Screenshots are masked
  locally and discarded if field geometry changes during capture. Embedded
  frames are masked in full. Full-mode evaluation returns `privacy_denied`
  for the remainder of a share once sensitive fields or uninspected embedded
  content have been observed, because arbitrary script could encode retained
  values around text redaction. Console and network inspection also return
  `privacy_denied` for the rest of such a share, and buffered diagnostics are
  discarded. This protects values entered and cleared between scans. Privacy
  inspection failures also fail closed.
- Action summaries omit field values and arguments. Extend uses only the
  browser credential, adds 30 minutes, and cannot exceed the 60-minute cap.
  Stop is terminal and detaches locally before waiting for a network response.
- Page content is untrusted. The extension never executes anything from the
  page; the agent is told (in the tool descriptions) that snapshot text is
  data, not instructions.

## 8. Client library, MCP server, CLI

`packages/client` owns sessions, crypto, transport, and the tool calls.
`packages/mcp` is a stdio MCP server exposing §6 as tools plus
`remote_tab_create` (prints the code for the human) and
`remote_tab_wait_ready`. `packages/cli` is `remote-tab` with one subcommand
per tool plus `create`, `wait-ready`, `status`, `stop`, and
`ledger export|render`. Both are thin; if a behaviour exists in only one, it
is a bug.

The shared browser transport is `BrowserPeer`; installed extension code owns
consent, mode/scope enforcement, redaction, and actual tab actions. Both peers
verify every read, including their own echoed appends. The client retries a
stale-chain append once, after verifying the new chain and resealing with a
fresh nonce. Ledger reads verify from genesis and fetch/decrypt referenced
blobs, including after stop or expiry.
`stop()` calls the terminal endpoint directly, without waiting for an encrypted
audit append or a pending poll. The ledger's status records the stopped state;
an encrypted `stop` message is not required for shutdown.

Client waits default to 120 seconds and accept a timeout and abort signal.
After observing redemption, the client allows 10 seconds for an authenticated
hello, then reports `hijack_suspected` and attempts terminal stop; this grace
period is configurable for slow transports. A failed hello is suspicion,
not proof of theft. `already_redeemed` remains the separate browser-facing
one-shot-redeem error (§4.4). No command is sent before a valid hello.

The M2 stdio MCP adapter exposes §6 plus create/wait-ready, configured by
`REMOTE_TAB_SERVER_URL` and `REMOTE_TAB_API_KEY`. It retains one current
session in memory. The shared client `statusDetails()` recovers verified hello
metadata without waiting for a new hello; CLI and MCP status include
transport metadata and authenticated hello mode/scope when available, even
after stop. The dead-drop status has no live
paused-by-human field; that state remains unknown until M3 adds authenticated
browser-state reporting. It must not be inferred as false.

The M2 Bun CLI accepts tool arguments as a JSON object and shares the same
client implementation. `create` saves only the session connection state in
a private local file (0600 inside a 0700 directory), refuses overwrite, and
prints the code with the private-delivery warning. Later commands resume
that file; the platform API key is not saved. Ledger export verifies and
decrypts everything before creating a new output directory. The CLI
`ledger render --out <file.gif|webm>` command currently reports that rendering
arrives with the M3 extension page.

Coding harnesses: Claude Code and Codex attach the MCP server or shell out to
the CLI. BeanOS sessions get a skill that wraps the CLI; the existing
`beanos-tab-share` skill is retired at cutover.

## 9. Ledger

Every message is in the chain (§5.2). The ledger viewer is an extension
page (or `remote-tab ledger` in the CLI); it decrypts, verifies the chain end
to end, and shows a timeline: command, plain-words summary, screenshot,
result. It is never served by the dead-drop server (§5.5). Export produces
`ledger.json` + `shots/*.png`. **Render** stitches the screenshots into a GIF
or WebM inside the extension page, keyed by the session id so the same
session always renders the same artifact. Rendering happens in the installed
client because the server cannot decrypt; there is no server-side media
pipeline.

## 10. Limits and defaults

| Knob | Default | Max |
|---|---|---|
| Session TTL | 30 min | 60 min (human-only extend) |
| Redeem window | 10 min | fixed |
| Message | 64 KiB | fixed |
| Blob | 4 MiB | fixed |
| Long-poll wait | 25 s | 25 s |
| Snapshot size | 200 KiB | fixed; agent narrows with `ref` |
| Object retention after expiry | 24 h | fixed |
| Creates per client IP per minute | 10 | `REMOTE_TAB_CREATE_PER_MINUTE` |
| Concurrent sessions per client IP | 20 | `REMOTE_TAB_ACTIVE_PER_IP` |
| Concurrent sessions globally | 500 | `REMOTE_TAB_ACTIVE_MAX` |
| Cumulative blob bytes per session | 64 MiB | `REMOTE_TAB_BLOB_BUDGET_BYTES` |
| Messages per session (both roles combined) | 5000 | `REMOTE_TAB_MESSAGES_MAX` |

All throttles apply in open and keyed mode and accept positive integer env
values. Exceeding one returns HTTP 429, JSON `error: "rate_limited"`, and
`Retry-After` seconds. Session blob/message budgets are lifetime totals; they
do not replenish by waiting. Reads and stop remain available at the cap.

Client identity defaults to the socket peer (last hop). Set
`REMOTE_TAB_TRUST_PROXY=1` only behind a trusted proxy that replaces untrusted
`X-Forwarded-For`; then the first IP in that header identifies the client.
Invalid/missing forwarded IPs fall back to the socket peer. IPv6 forms are
canonicalized and IPv4-mapped peers share the IPv4 quota. Without peer
information, requests share one `unknown` quota.

The create rate uses fixed 60-second windows **per instance**, so multiple
Cloud Run instances multiply that allowance. GCS-backed active caps are shared
across instances through a generation-matched admission index; unredeemed
`created` sessions count too, until stop or expiry. Memory storage is local
only. Blob-byte reservations and message sequence counts are on the session
record and updated atomically across GCS instances. Blob reservations happen
before upload; failed/ambiguous uploads conservatively consume budget.
Admission reservations similarly survive ambiguous failures until expiry.
The shared `admission/active-sessions.json` index must be excluded from bucket
cleanup rules. During rollout, drain old instances and allow pre-upgrade
sessions to expire (at most 60 minutes) before relying on the active caps: old
session records have no client IP/admission entry or historical blob-byte total.
Operators should use consistent limit configuration on all instances.

## 11. Threat model (short form)

- **Trust assumption: private delivery of the code.** The code carries the
  secret. It must travel on a private, authenticated channel to the intended
  human, and the docs, the CLI output, and the MCP tool description all say
  so. Everything below is conditional on that.
- **Session id leaks (without the secret).** A redeemer without the secret
  cannot produce a decryptable hello; the agent stops the session and the
  human sees "already redeemed". Worst case is denial of service for that
  session.
- **Complete code leaks before redeem.** The thief holds the secret and can
  win the one-shot redeem, impersonate the browser, and decrypt the commands
  the agent sends to that session. This is **not detectable
  cryptographically**. Mitigations, not guarantees: the redeem window is
  ≤ 10 min; the real human sees "already redeemed" and tells the agent; the
  agent stops the session. What the thief gains is bounded but real: the
  session is bound to a tab the thief controls, so they get no access to the
  intended human's browser, but they do receive everything the agent sends
  into that session, including any data the agent puts in commands (text it
  types, URLs it opens). A stronger pairing step (for example, a confirmation the human
  reads from the extension and returns to the agent out of band) is possible
  and deliberately not in v1.
- **Server or store compromised.** Attacker gets ciphertext, sequence numbers,
  timings, and the ability to deny service. No plaintext or keys when both clients use independent installed code.
  An agent executing server-fetched source explicitly trusts that operator
  with the key (§5.5). Compromise of a client
  distribution channel (Web Store, npm) is outside this model, as it is for
  any installed software.
- **Malicious page.** Snapshot text and eval output are data. The extension
  executes nothing from the page. Credential and payment fields are never
  captured. The agent-side tool descriptions carry the same warning.
- **Agent overreach.** Mode and scope are enforced in the extension, not the
  agent. Read-only cannot click; "this site only" cannot leave; nothing can
  extend the TTL from the agent side.
- **Human surprise.** Actions are shown live, every action is screenshotted
  into a ledger the human owns, and Stop is one click and terminal.

## 12. Deferred designs (recorded so they stay consistent)

- **Livestream.** A read-only viewer that long-polls the same messages and
  decrypts locally. Per §5.5 it is an installed client (a viewer mode of the
  extension, or the CLI), not a page served by the dead-drop server. Sharing
  a viewer code shares the key, so the human decides.
- **Replay as automation.** The ledger already holds the command sequence
  with refs and screenshots; a replayer would map refs onto a fresh snapshot
  and stop at handoff points. Not before the live path is solid.
- **Enterprise.** Admin-pinned scope and mode, SSO-stamped consent, export to
  SIEM. Needs an identity layer the v1 deliberately does not have.

## 13. Repository layout

```
packages/protocol   message and tool schemas (shared by everything)
packages/client     sessions, crypto, transport, tool calls (TypeScript)
packages/mcp        stdio MCP server over client
packages/cli        `remote-tab` over client
packages/server     dead-drop server (Bun), Dockerfile, reference deploy doc
packages/extension  Chrome extension (MV3), store packaging script
tests/e2e           fake tab over BrowserPeer, CLI and MCP lifecycle tests
docs/               this design, protocol reference, threat model
```

TypeScript throughout, Bun for tooling and the server, no framework in the
extension. One CI job runs unit tests plus headless end-to-end tests: real
server in-process, the shared browser protocol implementation (`BrowserPeer`)
driven by a deterministic fake tab, and the real client through CLI and MCP.
The M2 harness models snapshots, form actions, PNGs and human handoff; real
extension tab execution, consent UI and enforcement arrive in M3.
M3 acceptance includes extending this headless CI harness to execute the real
extension implementation against a fake tab, including mode/scope enforcement,
redaction and handoff. The M2 transport tests remain as regression coverage;
they do not replace that planned extension coverage or real-tab verification.

## 14. Deployment boundary

This repository ships code, a Dockerfile, and a reference deploy doc. It
never contains a specific deployment: no domains, project ids, service
accounts, or secrets. BeanOS deploys its instance from the
BeanOS monorepo's Terraform, the same way the paste-bin is deployed, using
open creation with throttling. Keyed deployments keep platform keys in their
own secret store.

## 15. Migration for BeanOS

1. Server live at its deployment-owned origin with open, throttled creation;
   BeanOS sessions need no platform key.
2. Extension 2.0 ships on the existing listing; it accepts the new code and,
   for one release, still accepts the 1.1.2 pointer/uuid.
3. `beanos-tab-share` skill becomes a wrapper over `remote-tab`; docs updated;
   old GCS pointer path removed from the extension in 2.1.

## 16. Milestones

1. **M1** this document + skeleton merged.
2. **M2** protocol + server + client with the headless end-to-end test green.
3. **M3** extension 2.0 driving a real tab against the server.
4. **M4** BeanOS cutover (§15).
5. **M5** open-source: license, security policy, public docs, store rename.

## 17. Decisions and remaining question

1. ~~License.~~ **Decided: MIT** (Gilad, 2026-09-18). `LICENSE` is in the repo
   from the first commit so nothing has to be relicensed at open-source time.
2. **Decided: optional platform API keys** (Gilad, 2026-09-18): “For the real
   BeanOS deployment we shall set reasonable throttling without API key.”
   BeanOS runs open + throttled. Operators may require static keys through
   `REMOTE_TAB_API_KEYS` as `platform:key` pairs, rotated by replacement.
   Short-lived broker-minted platform keys are deferred.
3. **Settled for v1: GCS-only session state**, with generation-matched cursor
   publication (§5.3) and shared admission accounting. Only the create-rate
   window is per instance. The memory store is for tests and local development.
4. **Open (Gilad):** store-facing extension name at open-source time.
