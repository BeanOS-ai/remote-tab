---
created: 2026-09-18
last_updated: 2026-09-24
last_reviewed: 2026-09-23
---

# remote-tab — design

Status: **implemented design**. Maintainers record decisions and remaining
release work here. License: MIT (decided 2026-09-18).

Remote Tab succeeds the earlier tab-share implementation with a redesigned
transport and an installed-client trust model.

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
| **Store** | Memory by default; optional Firestore + GCS adapter | ciphertext and bookkeeping; expiry cleanup |

## 4. Session lifecycle

The 2026-09-18 design amendment uses the short code and derived id
below. The extension implements this format from version 2.0.1; the previous
three-part format was never distributed.

1. **Create.** The agent client generates a random 16-byte (128-bit) secret
   locally and derives the session id: the first 32 lowercase hex characters
   of `SHA-256(UTF8("remote-tab/v1/session-id") || raw_secret_bytes)`. It sends
   `{id, ttl_seconds?}` to `POST /v1/sessions`, with a platform API key only
   when required (§5.3). The server returns `{id, agent_token, expires_at}`;
   the client verifies the returned id. A duplicate id returns 409 `id_taken`;
   treat it as a suspected replay and generate a fresh secret.
2. **Code.** After creation, the client prints `rt1.{base64url(secret)}`: exactly
   26 characters, including the prefix and 22 unpadded base64url characters.
   The secret never reaches the server. The extension derives the same id
   locally before redeeming. Previous three-part, 32-byte-secret codes are
   not accepted; no such release shipped. The agent
   hands the code to the human on a private channel; **the code is a bearer
   capability and private delivery is the trust assumption** (§11). There is
   no clickable link form in v1: a link would land on a web page, and any page
   that can read the secret is a client that must be trusted with it (§5.5).
3. **Redeem.** Extension parses the code locally, derives the id, then sends
   `POST /v1/sessions/{id}/redeem` with only that id. One-shot: the first redeem wins and returns `browser_token`;
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
   server serves no interaction summary page (§5.5). Store cleanup follows §5.3 retention
   eligibility; deletion is asynchronous. The export is the durable copy.

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
Agent code comes from the `remote-tab` npm package, not the server (§5.5,
§5.7); the server is an API, not a web application.

### 5.2 Crypto (deliberately boring)

- Secret: 16 random bytes (128 bits), generated by the agent client, carried
  in the 26-character code. The id is the first 128 bits of domain-separated
  SHA-256 as defined in §4. It is represented as 32 lowercase hex characters.
  The HKDF helper also accepts 32-byte inputs for crypto interoperability;
  the code parser accepts only the new 16-byte format.
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
  that session. `hash` is lowercase hex SHA-256 of UTF-8
  `{session-id}|{decimal-seq}|{base64url-ciphertext-with-tag}`: ASCII pipes,
  no spaces, ciphertext as the unpadded base64url string including the GCM tag.
  The server enforces the chain blind; the client verifies it after decrypting.

### 5.3 Server API (v1)

All bodies are JSON unless noted. Authorization is a bearer token: the
optional platform API key for create, `agent_token` or `browser_token` afterwards.
The server uses §5.6: anonymous creation is allowed unless
`REMOTE_TAB_ANONYMOUS_QPS=0`; a supplied platform key must resolve successfully
and never falls back to anonymous access. Both modes retain the backstops in §10.
The agent bootstrap page (`/docs`) is specified in §5.7; the server
serves no pages (§5.5).

| Method + path | Who | Purpose |
|---|---|---|
| `POST /v1/sessions` | agent (optional API key) | create; `{id, ttl_seconds?}` → `{id, agent_token, expires_at, redeem_until}` |
| `POST /v1/sessions/{id}/redeem` | browser (no token) | one-shot → `{browser_token, expires_at}` |
| `POST /v1/sessions/{id}/messages` | agent or browser | append `{role, prev_hash, nonce, ciphertext}` → `{seq, hash}` |
| `GET /v1/sessions/{id}/messages?after={seq}&wait=25` | agent or browser | long-poll up to 25 s; returns messages after `seq` |
| `POST /v1/sessions/{id}/blobs` | agent or browser | binary body (ciphertext), ≤ 4 MiB → `{blob_id}` |
| `GET /v1/sessions/{id}/blobs/{blob_id}` | agent or browser | binary |
| `POST /v1/sessions/{id}/extend` | browser only | `+1800 s`, capped at 3600 s total |
| `POST /v1/sessions/{id}/stop` | agent or browser | terminal |
| `GET /v1/sessions/{id}` | agent or browser | `{state, expires_at, last_seq, redeemed}` (no content) |

The default store is **in-memory only**, suitable for a single instance; restart
loses sessions. Self-hosters may implement the same `Store` boundary. The optional
`packages/store-gcp` adapter uses Firestore for session state/messages and GCS
only for ciphertext blobs. The former GCS `state.json`/message-pointer store is
retired. Select `REMOTE_TAB_STORE=memory|gcp` (default `memory`); unknown values
fail startup. GCP uses ADC, `REMOTE_TAB_FIRESTORE_DATABASE` (default `(default)`),
and `REMOTE_TAB_GCS_BUCKET`. Memory mode does not initialize cloud clients.

Firestore stores one `sessions/{id}` document with token hashes, state, expiry,
and chain head; its `messages` subcollection holds immutable sequence documents.
Append transactions check state/expiry, `prev_hash`, and caps, then atomically
create the message and advance seq/hash. Long-poll uses `onSnapshot` on the head
with timeout/expiry cleanup. Random incarnations isolate retained children from
reused session IDs. GCS uploads are create-only after byte reservation (§10).

Session TTL `delete_at` equals `expires_at + 24h`, updated on Extend. Children
have independent cleanup: messages use TTL at session creation + 60min + 24h; blob
`Custom-Time` is session creation + 60min with `daysSinceCustomTime: 1`. This prevents
partial Extend updates, retaining children up to 59min extra. Deletion is
asynchronous; soft deletion, holds, and backups can retain data longer.
See [GCP store contract](store-gcp.md) for provisioning and validation details.
Message cap remains 64 KiB; larger ciphertext goes through blobs.

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
scripts on the page. There is no landing page, code link, interaction summary viewer, or
browser-executed JavaScript on this server. The extension's Web Store
channel remains the human's client-code trust root.

Agent code ships as the `remote-tab` npm package (CLI and MCP server); the
server serves no agent code (2026-09-24: `/client-code` removed). **An agent
that runs code fetched from the server
trusts that server's operator with the complete shared session key.** The agent's and
human's copies are identical, not cryptographic "halves": compromised agent
code can expose commands, browser results, and screenshots. Agents run the
package from the registry.

The API and the `/docs` bootstrap page below are the entire public surface.
No HTML and no JavaScript executed by a browser. Everything else returns 404. Code handoff stays
private; ledger viewing and any future livestream remain installed clients.

### 5.6 Key service contract

Decision (2026-09-18): API keys are optional; server providers run key
services and tiers outside this repo. The server implements the contract below. The server
handles opaque identity and numeric limits only: no email, billing, key
issuance, or tier-specific product logic belongs here.

- `KeyResolver.resolve(key)` returns `{tier: string, qps: number, subject: string}`
  or `null`. `StaticKeyResolver` reads comma-separated
  `REMOTE_TAB_API_KEYS=platform:key[:qps]` entries, including the existing
  two-field form (default QPS 10, tier `static`, subject equal to platform).
  An optional final numeric field is the QPS suffix; platform and key must be
  nonempty. The two-field form is unchanged. For a legacy key containing
  colons and ending in a numeric field, append an explicit QPS suffix to
  preserve the full old key (old `platform:key:123` becomes
  `platform:key:123:10`). Do not silently accept both credential
  interpretations. `qps` is a nonnegative safe integer; 0 means unlimited.
  `HttpKeyResolver` takes precedence when its URL is configured and uses `REMOTE_TAB_KEY_SERVICE_URL` and
  `REMOTE_TAB_KEY_SERVICE_TOKEN`: authenticated `GET {url}/resolve?key={sha256}`
  with a bearer service token. The query contains lowercase hex SHA-256 of
  the presented key, never the raw key. Positive cache TTL is
  `REMOTE_TAB_KEY_CACHE_SECONDS` (default 300 seconds); negative results cache
  for 60 seconds. Key-service failures fail closed for keyed requests;
  anonymous requests do not contact or depend on that service. A miss returns
  401; transport errors, invalid claims, and service failures return 503
  `key_service_unavailable`, without using stale cached claims. Cache keys are
  hashes, never raw keys. Positive TTL 0 disables positive caching.
- Preserve the existing bearer-token roles. Creation accepts the platform key;
  the server stores only its SHA-256 fingerprint and immutable resolved subject
  on that session. Later session calls still authenticate with agent/browser
  tokens, then inherit the creator's rate and usage identity. Internal
  fingerprint resolution refreshes tier/QPS through the same caches and HTTP
  endpoint without storing the raw key; a changed subject or revoked key is
  refused. `resolve(key)` remains the public raw-key interface, while the two
  implementations also expose an internal `resolveHash(fingerprint)` path.
  Tokenless redeem inherits the located session's creator policy, so keyed
  sessions still pair when anonymous QPS is 0. This does not prove secret
  possession (§4): id-only redeem denial of service remains possible. Unknown
  sessions and invalid role tokens receive the caller-IP limit before failure.
  When anonymous QPS is 0, rejected unauthenticated calls use a separate
  10-QPS caller-IP abuse guard; this only throttles denial responses and never
  grants anonymous access. Missing platform keys return 401 in that mode.
  Anonymous sessions use the current caller IP on every request. No platform
  key enters the code, browser, exported agent session state, or ledger.
- Anonymous calls use per-client-IP QPS from `REMOTE_TAB_ANONYMOUS_QPS`
  (default 10; 0 requires keys). Keyed calls use the resolved QPS; 0 means
  unlimited. All API calls count, including each long-poll request once.
  This includes bootstrap/docs/source requests; on a key-required deployment
  those requests need a platform bearer too. Clients, CLI, and MCP omit the
  platform Authorization header when no key is configured, never use a sentinel,
  and retain their existing role-token headers afterwards.
  Exceeding a limit returns 429, JSON `error: "rate_limited"`, and integer
  `Retry-After` seconds. Existing active-session caps, message counts, and blob
  budgets remain as independent backstops. Shared clients honor explicit
  `429 rate_limited` responses with `Retry-After` within their existing
  operation deadline and cancellation signal, so normal bursts and multi-blob
  ledger exports can finish. Retry only a server-confirmed rejection before
  mutation; never replay ambiguous network failures or other writes. If the
  delay exceeds the remaining deadline, surface the rate-limit result.
- Use `rate-limiter-flexible` pinned to `11.2.1` as the only new server runtime dependency and its
  `RateLimiterMemory`, with `points = qps`, `duration = 1` second, keyed by
  resolved subject or client IP (separate namespaces). Unlimited keyed QPS
  bypasses the limiter; anonymous QPS 0 instead requires a key. Reject
  fractional/negative/nonfinite QPS rather than silently rounding. This is a
  one-second window allowance, with
  no custom bucket implementation. Multiple keys resolving to the same
  subject share one counter. Cache refreshes and tier/QPS changes retain the
  current window consumption rather than creating a bucket per tier or QPS.
  Limits are per server instance; multiple
  instances multiply the allowance. The same library can use a shared
  Redis/Postgres backend if global rate limits become necessary.
- `UsageSink` accepts `{subject | ip, tier, kind, amount, at}` events; `kind`
  is `session_created`, `message`, `blob_bytes`, or `throttled`. Subjects and
  IPs are separate identity types. Default `LogUsageSink` aggregates amounts
  by identity, tier, and kind per minute, then writes one structured JSON
  line per aggregate. Amounts count successful session creations (1), appended
  messages (1), accepted uploaded ciphertext bytes, and quota rejections (1);
  reads are rate-limited but do not count as additional messages/blob bytes.
  Optional `HttpUsageSink` uses `REMOTE_TAB_USAGE_URL`
  and the same service token to POST event batches. Reporting is best effort,
  bounded, and never blocks or changes an API response; no raw keys, tokens,
  secrets, URLs, or message contents enter usage events.
- `/docs` explains anonymous versus keyed access, presenting platform keys
  using `Authorization: Bearer`, and that the server operator supplies its
  keys and tiers. Generic guidance leaves key-service deployment to the provider.
  A clearly delimited hosted-service section may document that deployment's
  URLs and key onboarding; self-hosters should skip it and issue their own keys.

### 5.7 Agent bootstrap (2026-09-18 addendum; npm package 2026-09-24)

- `GET /docs` returns `text/markdown; charset=utf-8`: a short agent quick
  start for the `remote-tab` npm CLI (create, private code delivery, the core
  commands, the three safety rules, the `skill` and `--help` commands, and the
  MCP configuration). It links the repository for the protocol, security model
  and self-hosting documentation (2026-09-24: Gilad found the embedded protocol
  reference too verbose). `scripts/generate-bootstrap.ts` owns the text; the
  build rejects a document larger than 4,000 UTF-8 bytes.
- The quick start pins `npx -y remote-tab@{version}`, where the version is the
  `npm/remote-tab/package.json` release embedded at build time.
- `REMOTE_TAB_PUBLIC_ORIGIN` names the origin agents use; when it is set, the
  docs use it in their examples. It is configuration, never derived from
  request headers, and must be a plain `http(s)` origin. When it is unset, the
  docs show a placeholder origin.
- `/client-code` (a 2026-09-18 source index, then briefly a script running the
  npm package) is removed; it returns 404 like any other path.
- After authentication and request limiting, other paths and non-GET methods
  return 404. Nothing is read from the filesystem at request time.
- Publish the npm release before deploying a server built with its version:
  the docs pin that exact version.

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
`debugger`, and `notifications` (handoff attention only); host permission for the server origin only. Unused legacy
`scripting` and `storage` permissions are omitted. `REMOTE_TAB_SERVER_ORIGIN` is a
build-time distribution setting, compiled into both the worker and manifest; the
repository default is `https://remote-tab.example`. Chrome 125 or newer is
required for flattened debugger child-frame sessions. The active debugger
session keeps the MV3 service worker alive.
Session secrets stay only in memory. Browser restart or debugger loss ends
local control; there is no automatic resume or command replay. The human
must start a fresh share after a restart. Built artifacts are ignored.

`packages/extension/package-store.sh` builds a deterministic store ZIP from
fresh source with an explicit HTTPS `REMOTE_TAB_SERVER_ORIGIN`; release
packaging rejects the default placeholder. The root manifest and runtime,
local icons, MIT license, and corresponding PSL data/license notices form an
explicit allowlist. No test files, source maps, credentials, or deployment
configuration enter the archive. Version is read from the extension package
(2.2.1); the display name is **Remote Tab** and the ZIP basename is
`remote-tab-{version}.zip`. This rename does not update the public listing or
the separate legacy Bean Tab Share tool.
Packaging does not upload or publish the extension.

Popup: paste field, mode (read-only / act / full; full is labelled as
scripting access), checkbox **this site only**, **Read my tab** in Read-only mode or
**Control my tab** in Act/Full mode. The footer reads **by BeanOS.ai**. While
shared: shared tab title and origin, **Go to shared tab** when viewing another
tab, a live feed of actions in plain words ("clicked Submit", "typed into Search"), a **Stop** button that is always visible, an
**Extend** button near expiry, the handoff banner with **Done**, and a
**Pause** / **Resume** control with a timestamped **Paused by you** state.
The on-page handoff banner is informational: its host remains page-controlled,
so it has no Done button or acknowledgement bridge. Completion requires the
extension-owned popup's Done control. The action badge and handoff notification
remain visible independently of page DOM; notification clicks focus the shared
tab/window without acknowledging the handoff.

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
- **Explicit Pause / Resume.** Only the installed popup's Pause control pauses
  browser commands. Moving, clicking, typing, scrolling, or navigating in the
  shared tab does not automatically pause; work in other tabs is unaffected.
  An interrupted command returns `paused` even if Resume is clicked before it
  finishes, without uploading its result or screenshot. Resume permits new
  commands and never replays the interrupted command. An agent-requested handoff
  still waits for the human's Done control; Resume cannot bypass it.
  Diagnostic buffers are cleared on Pause and no events are collected while
  paused. Protected-field scanning, masking, scope enforcement and Stop remain
  separate safeguards. Stop always detaches locally before network cleanup.
  This replaces the original trusted-input/timestamp takeover design as decided on
  2026-09-19: Chrome's extra trusted events and ordinary human
  movement made automatic takeover too brittle (#28). Users must explicitly
  Pause before working privately in the shared tab; input no longer signals
  consent to interrupt automatically. No takeover listeners or synthetic future
  timestamps are injected.
  Pause/Resume actions retain UTC timestamps in the popup activity and in the
  extension's interaction summary viewer and ZIP as local control records, labelled separately
  from the authenticated encrypted command chain. The `rt1` wire protocol stays
  compatible; existing CLI ledgers do not contain these extension-local records.
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
`ledger export|render`, `skill` (prints the agent skill) and `version`. Both
are thin; if a behaviour exists in only one, it is a bug. Both ship as the
`remote-tab` npm package (`npm/remote-tab`): Node bundles built by
`scripts/build-npm.ts`, bins `remote-tab` and `remote-tab-mcp`. The CLI is the
preferred agent interface.

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
`REMOTE_TAB_SERVER_URL` and optional `REMOTE_TAB_API_KEY`. It retains one current
session in memory. The shared client `statusDetails()` recovers verified hello
metadata without waiting for a new hello; CLI and MCP status include
transport metadata and authenticated hello mode/scope when available, even
after stop. The dead-drop status has no live paused-by-human field. The
extension answers authenticated `remote_tab_status` commands with live pause
state, but the MCP/CLI transport-status adapters do not yet request it and
must not infer an unknown value as false. The popup shows current pause state,
and queued browser commands receive `paused` while explicitly paused.

The M2 Bun CLI accepts tool arguments as a JSON object and shares the same
client implementation. `create` saves only the session connection state in
a private local file (0600 inside a 0700 directory), refuses overwrite, and
prints the code with the private-delivery warning. Later commands resume
that file; the platform API key is not saved. Ledger export verifies and
decrypts everything before creating a new output directory. The CLI
`ledger render --out {file.gif|webm}` command currently reports that rendering
is available in the installed extension interaction summary page; CLI rendering itself remains unimplemented.

Coding harnesses: Claude Code and Codex attach the MCP server or shell out to
the CLI. See the [agent skill](../skills/remote-tab/SKILL.md) and
[copyable examples](../examples/) for both interfaces.

## 9. Ledger

Every message is in the chain (§5.2). The interaction summary viewer is an extension
page (or `remote-tab ledger` in the CLI); it decrypts, verifies the chain end
to end, and shows a timeline: command, plain-words summary, screenshot,
result. It is never served by the dead-drop server (§5.5). Export produces
`ledger.json` + `shots/*.png`. **Render** stitches the screenshots into a GIF
or WebM inside the extension page, keyed by the session id so the same
session always renders the same artifact. Rendering happens in the installed
client because the server cannot decrypt; there is no server-side media
pipeline.

M3 implements this as an installed `ledger.html` page. Stop opens it immediately
while local control detaches; retrieval waits for the terminal request to settle.
An active **View interaction summary** is an explicitly labeled immutable snapshot, and only
stopped/expired snapshots enable final GIF rendering. Snapshot state and chain
head come from the same captured status: a later concurrent Stop cannot label
an earlier active snapshot as final. Each transfer captures its
original browser peer, so a subsequent share cannot replace the history. The
worker uses the existing peer to authenticate/decrypt and verify the ledger;
bounded runtime-message chunks carry decrypted data, never the key, to the page.
The page repeats `verifyChain`, checks the final sequence/hash and attachment
hashes, and releases the worker copy after successful transfer. Closing a viewer
or a failed load also attempts to release its transfer slot. It then works
from page memory even if the worker sleeps. Neither keys nor ledgers persist to
extension storage: closing/reloading the page or restarting before export can
lose the in-memory history.

ZIP uses the CLI's `ledger.json` / `shots/*.png` / other-blob layout. The in-repo
MIT GIF encoder uses fixed 640×360 letterboxed frames, a deterministic RGB332
palette, one second per screenshot, and a session-id comment. No CDN, external
media service, or dependency is required. The viewer explicitly refuses ledgers
over 5,000 entries / 96 MiB (32 MiB transfer metadata) and GIFs over 300 screenshots;
the shared client enforces retrieval budgets and reads attachments sequentially,
and the viewer never silently drops entries to fit. Pending worker transfers expire after
five minutes and at most two coexist. ZIP remains available when GIF rendering
exceeds its limits.

## 10. Limits and defaults

| Knob | Default | Max |
|---|---|---|
| Session TTL | 30 min | 60 min (human-only extend) |
| Redeem window | 10 min | fixed |
| Message | 64 KiB | fixed |
| Blob | 4 MiB | fixed |
| Long-poll wait | 25 s | 25 s |
| Snapshot size | 200 KiB | fixed; agent narrows with `ref` |
| Cleanup eligibility | expiry +24h | child retention/deletion caveats (§5.3) |
| Anonymous API requests per client IP per second | 10 | `REMOTE_TAB_ANONYMOUS_QPS`; 0 requires keys |
| Keyed API requests per subject per second | resolved QPS | 0 unlimited; per instance (§5.6) |
| Concurrent sessions per client IP | 20 | `REMOTE_TAB_ACTIVE_PER_IP` |
| Concurrent sessions globally | 500 | `REMOTE_TAB_ACTIVE_MAX` |
| Cumulative blob bytes per session | 64 MiB | `REMOTE_TAB_BLOB_BUDGET_BYTES` |
| Messages per session (both roles combined) | 5000 | `REMOTE_TAB_MESSAGES_MAX` |

Active-session and per-session backstops apply in anonymous and keyed mode
and accept positive integer env values. QPS configuration follows §5.6.
Exceeding one returns HTTP 429, JSON `error: "rate_limited"`, and
`Retry-After` seconds. Session blob/message budgets are lifetime totals; they
do not replenish by waiting. Reads and stop remain available at the lifetime
blob/message cap, subject to QPS and current key authorization.

Client identity defaults to the socket peer (last hop). Set
`REMOTE_TAB_TRUST_PROXY=1` only behind a trusted proxy that replaces untrusted
`X-Forwarded-For`; then the first IP in that header identifies the client.
For proxies that append rather than replace that header, configure
`REMOTE_TAB_TRUST_PROXY_HOPS` to select from the right of the chain consisting
of the forwarded addresses followed by the socket peer: skip exactly that
many trusted hops. It takes precedence over the legacy flag. Restrict ingress
to that trusted chain; the application does not authenticate proxy hops.
Invalid/short chains fall back to the socket peer. This avoids trusting an
attacker-controlled first entry behind an appending load balancer.
Invalid/missing forwarded IPs fall back to the socket peer. IPv6 forms are
canonicalized and IPv4-mapped peers share the IPv4 quota. Without peer
information, requests share one `unknown` quota.

The one-second request limits remain **per instance** (§5.6). Memory active caps
are local. The GCP adapter shares active caps through a transactionally updated
`admission/active` lease document; creation and Extend update the lease and
session atomically, Stop removes it, and new admission prunes expired leases.
Unredeemed sessions count. The adapter caps configured global admission at
1,000 entries to bound document size; deployments use consistent limits.
Session message counts and blob-byte reservations are transactional. Failed or
ambiguous uploads conservatively consume budget. Blob authorization linearizes
at reservation; Stop after it may leave an unreferenced ciphertext object for
lifecycle cleanup. Store writes recheck expiry, including after async work.
Switching from the retired GCS store requires draining old sessions first;
there is no dual-read migration or shared state between the two adapters.

## 11. Threat model (short form)

- **128-bit secret and derived id.** CSPRNG entropy is sufficient against
  guessing during the ≤10-minute redeem window. Domain-separated SHA-256
  makes the id unpredictable without the secret before disclosure; creation
  completes before the code is delivered, preventing advance id squatting.
  The server validates id shape, not knowledge of the secret: a disclosed id
  can still be redeemed for denial of service, while only an authenticated
  hello proves secret possession. The derived id gives a courier no extra
  advantage; a courier that sees the complete code already holds the secret.

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
  executes nothing from the page, and `browser_evaluate` runs in an isolated
  world so page script cannot redefine what the agent reads back. Fields the
  page marks as credential or payment are not captured — a best effort that
  depends on the page labelling them (`sensitive()` matches `type="password"`
  and the `one-time-code` / `cc-*` autocomplete tokens), so a page collecting
  secrets in ordinary text fields defeats it. The agent-side tool descriptions
  carry the same warning.
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
npm/remote-tab      the published `remote-tab` npm package (CLI + MCP bundles)
tests/e2e           fake tab over BrowserPeer, CLI and MCP lifecycle tests
tests/browser       real Chromium, installed MV3 extension, offline fixtures
docs/               this design, protocol reference, threat model
```

TypeScript throughout, Bun for tooling and the server, no framework in the
extension. One CI job runs unit tests plus headless end-to-end tests: real
server in-process, the shared browser protocol implementation (`BrowserPeer`)
driven by a deterministic fake tab, and the real client through CLI and MCP.
The M2 harness models snapshots, form actions, PNGs and human handoff. M3 adds
the actual extension driver against fake CDP, including mode/scope enforcement,
redaction, handoff, explicit pause, Stop/expiry races, and verified ledger/media export.
A separate browser CI job loads the built MV3 extension in real Chromium and
drives AgentSession against a local server and offline fixture pages, covering
actions, privacy, human controls, and ledger verification/export. Only browser
unavailability permits a reported skip; assertion failures fail the job. Focused
Chromium smoke scripts also cover privacy pixels, GIF decoding, and the store
archive. The 30-minute manual plan in `docs/manual-test-plan.md` remains required
for human acceptance, including a human handoff with text entry and extension
updates. A real MFA account is not required: the handoff check proves the human
can act in the shared tab while the agent waits, which is the same mechanism a
sign-in or MFA step uses. Transport
tests remain regression coverage alongside these checks.

## 14. Deployment boundary

This repository ships product code, a Dockerfile, and a
[self-hosting guide](self-hosting.md). Production domains, cloud projects,
service accounts, and secrets belong to each deployment. The agent API guide
separately documents the hosted service for users who choose it.

## 15. Migration

The generic extension accepts only `rt1.` codes. Legacy short-key/pointer
flows need extra deployment-owned origins and are outside this repository.
Distributions must manage their own temporary compatibility adapters and
remove them after cutover; generic host permissions stay limited to the
configured server origin.

## 16. Release verification

Protocol, server, client, CLI, MCP, and extension implementations have automated
coverage. `scripts/npm-smoke.ts` installs the packed npm tarball with npm and
runs both bins under Node against a local relay. The `publish-npm` workflow
publishes the release; publish it before deploying a server that pins it (§5.7). Distribution acceptance still requires the
[manual test plan](manual-test-plan.md); packaging is separate from publication.
Maintainers own security review and release readiness.

## 17. Decisions

1. **Decided: MIT** (2026-09-18). `LICENSE` is in the repo
   from the first commit so nothing has to be relicensed at open-source time.
2. **Decided: optional API keys with an external key-service contract**
   (2026-09-18): API keys are optional; server providers run key services
   and tiers outside this repo. §5.6 defines static/HTTP resolvers, per-subject
   or per-IP QPS, and best-effort usage sinks. The only new server runtime
   dependency is pinned `rate-limiter-flexible` with its memory backend;
   shared backends remain an option. No emails, billing, tier product logic,
   or deployment values enter this repo. Anonymous defaults to 10 QPS;
   setting 0 requires keys. The client and CLI/MCP support omitted platform keys.
3. **Decided: memory default; optional Firestore + GCS adapter** (2026-09-18). Firestore owns session/message transactions and listeners; GCS
   stores blobs only (§5.3). Self-hosters may add adapters. The state.json
   cursor transport is retired. Shared GCP active caps do not change per-instance
   request QPS. Child retention conservatively covers the maximum Extend window.
4. **Decided: Remote Tab** is the extension display name.
