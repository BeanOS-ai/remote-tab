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

Status: design phase. Read [`docs/design.md`](docs/design.md). License: MIT.

This repository is private while the first version is built and will be
open-sourced afterwards. It contains the product only: extension, server,
client library, MCP server, CLI, protocol, and docs. Any specific deployment
of the server (domains, cloud projects, secrets) lives outside this repo.
