---
created: 2026-09-18
last_updated: 2026-09-18
last_reviewed: 2026-09-18
---

# Chrome extension

Installed Manifest V3 client for one explicitly shared tab. Source only is committed;
generated extension files go in the ignored `dist/extension` directory.

Build with `bun run packages/extension/build.ts`. Set `REMOTE_TAB_SERVER_ORIGIN`
when packaging a distribution. It is compiled into both the worker and manifest
host permissions; the default `https://remote-tab.example` is a placeholder.
The server never supplies browser code. Session codes and secrets stay in memory
and are never logged or saved to extension storage.
