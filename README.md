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

Status: M2 server implemented; client, MCP, CLI and headless end-to-end are in progress. Read [`docs/design.md`](docs/design.md). License: MIT.

This repository is private while the first version is built and will be
open-sourced afterwards. It contains the product only: extension, server,
client library, MCP server, CLI, protocol, and docs. Any specific deployment
of the server (domains, cloud projects, secrets) lives outside this repo.

## Server and agent bootstrap

Run `bun install`, then `bun run build`; deploy the self-contained
`dist/main.js` with Bun. Configure `REMOTE_TAB_API_KEYS` as
`platform:key[,platform:key]` through the host environment. The default store
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
