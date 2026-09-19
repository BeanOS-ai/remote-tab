# Remote Tab popup evidence

Captured September 19, 2026 with `scripts/extension-popup-smoke.mjs` for issues
#34 and #35. These are real Chromium renders of the production popup HTML,
CSS, mascot and bundled TypeScript, with a **mocked Chrome runtime and tab
provider**. They verify display and popup message dispatch; they do not prove
installed-extension focus, cross-window activation, relay connectivity or
human acceptance.

| Screenshot | State |
| --- | --- |
| [consent.png](consent.png) | Remote Tab name, Read-only default, Read my tab, by BeanOS.ai |
| [sharing.png](sharing.png) | Popup on the shared tab; interaction summary control |
| [other-tab.png](other-tab.png) | Shared title and origin; Go to shared tab |
| [paused.png](paused.png) | Explicit Pause and Resume controls |
| [closed-tab.png](closed-tab.png) | Closed-tab notice, Stop available, no focus or agent controls |

The smoke also checks all three mode labels, unchanged validation behavior,
Stop during startup, handoff/Resume exclusivity, near-expiry Extend, safe text
rendering, focus dispatch without caller-supplied tab/window IDs, and reset to
the current tab after Stop. The focus test updates the mocked active tab; the
worker's actual Chrome focus calls require their separate integration checks.

Reproduce from the repository root with existing Playwright and Chromium:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chrome \
POPUP_SCREENSHOT_DIR=docs/evidence/popup \
bun scripts/extension-popup-smoke.mjs
```

This capture used Bun 1.3.13 and the preinstalled Playwright Chromium 1217
distribution. No dependency installation was performed. The repository's CI
uses its declared Bun version separately.
