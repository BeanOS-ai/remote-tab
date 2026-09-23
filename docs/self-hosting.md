---
created: 2026-09-23
last_updated: 2026-09-23
last_reviewed: 2026-09-23
---

# Self-hosting

Use **Bun 1.4.2**, the pinned CI and container build baseline. The committed v2
lockfile is incompatible with Bun 1.3.13 frozen installs; do not rewrite it or
disable `--frozen-lockfile` to accommodate an older build image. Newer versions
require validation before updating the build pin.

Run `bun install --frozen-lockfile`, then `bun run build`; deploy `dist/main.js` with Bun.
The generic server image uses the same Bun version, pinned by tag and immutable
multi-platform digest:

```sh
docker build -f packages/server/Dockerfile -t remote-tab .
docker run --rm -p 8080:8080 remote-tab
```

The image defaults to the in-memory store, runs as an unprivileged user, and
includes the optional GCP adapter's production dependencies. Its build prints
`bun --version`; CI builds this Dockerfile and checks runtime packaging without
cloud access. Distribution-owned Dockerfiles and base-image overrides must
select the same compatible Bun baseline; an upstream pin cannot override them.

The API is key-optional: anonymous calls default to 10 requests/second/IP.
Present a platform key with `Authorization: Bearer {key}` on creation or
bootstrap requests for the operator's resolved QPS. Session requests keep
agent/browser bearer tokens; they inherit the creator's key identity without
resending its platform key. Set anonymous QPS to 0 to require keys. A supplied
invalid key is always refused, never silently treated as anonymous.

Operators can use static keys or an external key service. Static entries are
`platform:key[:qps]` (default 10 QPS, subject `platform`, tier `static`). If a
legacy key contains colons and ends with a number, append an explicit QPS to
preserve that key: `platform:key:123:10` keeps raw key `key:123`. HTTP resolution
sends only SHA-256 of the key to `{base}/resolve?key={hash}` with the service
bearer token and expects `{tier,qps,subject}` or HTTP 404. Other service errors
fail closed with 503 for keyed traffic; anonymous traffic is unaffected.
Claims cache for 300 seconds (misses: 60), so revocation takes effect after
cached approval expires. A session's subject cannot change on refresh.

Keys and tiers come from whoever operates the server. Key issuance and tier
management live outside this repository; ask your server provider for access.
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

See the [GCP store contract](store-gcp.md) for layout, IAM, retention, and
emulator validation. Migration requires draining the old GCS cursor deployment;
there is no dual-read compatibility or live migration. Self-hosters may supply
other implementations of the exported `Store` interface.

`GET /docs` serves generated agent quick-start markdown. `GET /client-code`
lists versioned, SHA-256-indexed protocol/client/CLI source files present in
the build; fetch a file at `/client-code/{path}`. There are no browser pages.
Running source from that server means trusting its operator with the agent's
session key. Prefer independently distributed packages when possible; see
design §5.5 for the explicit custody tradeoff.

The build compiles the docs from `docs/design.md`, `docs/agent-api.md` and
`docs/crypto-vector.json`, and embeds source bytes. After editing docs or
source, regenerate with `bun run generate`. Run `bun run test` and
`bun run check` for tests and formatting; `bunx tsc -p tsconfig.json` checks
types. CI builds before checking/tests, so source changes cannot leave the
served assets stale in a release.

## Extension distribution

Build and run the server with Bun as described above. Put the API behind your
own HTTPS origin; choose the store and creation/auth limits in your deployment
configuration. Keep credentials outside this checkout. `/docs` provides the
agent bootstrap; the server never hosts a consent or interaction summary page.

The installed extension must be built for that same origin. From a clean
checkout with Bun, Python 3, and workspace dependencies installed:

```sh
REMOTE_TAB_SERVER_ORIGIN=https://tabs.example.org \
  packages/extension/package-store.sh /tmp/remote-tab-2.2.0.zip
```

The release packager requires an explicit HTTPS origin and rejects the default
placeholder. It builds from source into a temporary directory, then includes
only the manifest, local runtime/assets, and license notices. The manifest's
host permission and worker configuration derive from the same setting. No
production credential or deployment configuration is committed here.

For development, `bun packages/extension/build.ts` writes `dist/extension` for
Chrome's **Load unpacked**. Its default `https://remote-tab.example` is a
placeholder; HTTP loopback origins are permitted only for development builds.
The extension is named **Remote Tab**. Store uploads and publishing remain
separate distribution actions; this display rename does not publish an update.
See [extension usage](../packages/extension/README.md) for consent,
controls, privacy behavior, and local ledger export.

The generic build accepts only `rt1.` codes. Legacy short-key/pointer flows
require extra deployment-owned origins and are not supported here. Any migration
adapter belongs in a separate distribution and must be retired after its cutover.
The generic host permission remains exactly the configured server origin.
