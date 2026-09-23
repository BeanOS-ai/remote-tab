---
created: 2026-09-23
last_updated: 2026-09-23
last_reviewed: 2026-09-23
---

# Development and verification

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
fake CDP. The separate `bun run test:browser` suite loads the built Manifest V3
extension in real Chromium and exercises its protocol and human controls with
local offline fixtures. Its CI job may skip only when Chromium cannot launch;
assertion failures fail the job. Existing focused Chromium smoke scripts remain
available; see [verification instructions](../packages/extension/README.md).

```sh
bun tests/browser/node_modules/playwright/cli.js install --with-deps chromium
bun run test:browser
```

`CHROMIUM_EXECUTABLE` can select an installed Chromium. Environments whose
network broker prevents loopback HTTP can explicitly use
`BROWSER_INPROCESS_HTTP=1`; this routes local requests to the same in-process
server while retaining the actual installed extension and CDP APIs. CI uses
normal localhost HTTP. This option does not relax assertions or bypass proxies.

Before distribution acceptance, run the mandatory
[30-minute manual test plan](manual-test-plan.md) and fill in its results table.
Automated coverage does not establish real-site MFA behavior, production ingress,
store provisioning, or Chrome Web Store approval. No public or store release is
performed by these tests. The CLI/MCP transport status does not query live human-pause state; the popup
shows it and queued commands receive `paused`. Distribution migration, release
review, and publication are separate maintainer responsibilities.

