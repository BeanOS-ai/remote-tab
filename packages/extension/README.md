---
created: 2026-09-18
last_updated: 2026-09-19
last_reviewed: 2026-09-19
---

# Remote Tab Chrome extension

Installed Manifest V3 client for one explicitly shared tab. Source only is committed;
generated extension files go in the ignored `dist/extension` directory.

Build with `bun run packages/extension/build.ts`. Set `REMOTE_TAB_SERVER_ORIGIN`
when packaging a distribution. It is compiled into both the worker and manifest
host permissions; the default `https://remote-tab.example` is a placeholder.
The server never supplies browser code. Session codes and secrets stay in memory
and are never logged or saved to extension storage.


Load `dist/extension` using **Load unpacked** on `chrome://extensions` (Developer
mode). Chrome 125+ is required. Open a normal HTTP(S) tab, paste the private code,
choose the access mode and site scope, then **Read my tab** in Read-only mode or
**Control my tab** in Act/Full mode. Stop immediately
detaches Chrome's debugger, even if the server is unreachable. Closing the tab,
losing debugger control, expiry, or a transport integrity error ends local control.
A browser/worker restart requires a new code and fresh consent; actions are never
replayed from saved state.

Site scope uses the complete vendored Public Suffix List, including private
suffixes. The data keeps its upstream MPL-2.0 license; extension code is MIT.
Screenshots always use the attached target via CDP, never the active window.
Large snapshots travel as encrypted JSON attachments under the protocol's
message ceiling. Network inspection always redacts credential headers.

During a share, the popup identifies the shared tab by title and origin. When
opened from another tab, **Go to shared tab** activates it and focuses its window.
If that tab is closed, the popup says so and keeps **Stop** available.

The popup shows recent actions, Pause/Resume, Stop, Extend near expiry, handoff
Done, and **View interaction summary**. Human movement, typing and navigation
do not automatically pause sharing. Click **Pause** before working privately in the shared tab;
**Resume** allows new commands without replaying interrupted ones. An interrupted
command stays interrupted even if the human quickly resumes. Chrome's debugging
bar is expected. The popup and interaction summary show timestamped local
Pause/Resume records; these are separate from the verified encrypted command chain.

Version 2.1.0 fixes #28/#29 and replaces automatic takeover with explicit controls
per Gilad's September 19 direction. The minor bump marks that behavior change.
After review and merge, the operator repackages the private ZIP; no store or
public-bucket release is part of this change.

Password, one-time-code, and payment-card fields are scrubbed from results and
masked locally in screenshots; embedded frames are masked in full. Full-mode
scripting and console/network inspection are refused for the rest of a share
once protected fields or uninspected frames are encountered. Diagnostic buffers
are discarded at that boundary.
If privacy inspection or screenshot geometry validation fails, no result or
image is sent. Session-only redaction state is never persisted.

Stop opens an installed interaction summary page automatically.
**View interaction summary** opens an immutable snapshot while sharing. The worker decrypts and verifies using the
existing browser peer, then transfers bounded chunks to the page without the
session key. The page verifies the chain, final sequence/hash, and attachment
hashes before enabling export. Completed transfers stay usable if the worker
sleeps; no key or ledger is saved to extension storage. Closing/reloading the
page or restarting the browser can lose that in-memory history, so export it.

**Export ZIP** downloads `ledger.json`, `shots/*.png`, and any other blobs in the
CLI export layout. Stopped/expired sessions can **Render GIF** locally: fixed
640×360 frames, one second per screenshot, a deterministic RGB332 palette, and
the session id in the artifact. No media or code is fetched from a CDN. Rendering
supports up to 300 screenshots; exceeding a limit shows an error rather than
silently omitting history. The viewer accepts up to 5,000 entries / 96 MiB, with
32 MiB of metadata; pending transfers expire after five minutes.

Package version 2.2.0 for distribution with Bun and Python 3:

```sh
REMOTE_TAB_SERVER_ORIGIN=https://tabs.example.org \
  packages/extension/package-store.sh /tmp/remote-tab-2.2.0.zip
```

Release packaging requires an explicit HTTPS origin and rejects the development
placeholder. It packages fresh runtime files, local icons, and MIT/PSL license
and source notices with a root manifest, fixed archive metadata, and no tests
or source maps. Existing output is refused unless `--force` is explicitly supplied. With no output argument it
writes under ignored `dist/`. No upload or publication occurs.

The extension is named **Remote Tab**, with the attribution **by BeanOS.ai**.
The release artifact basename is `remote-tab-<version>.zip`; packaging does not
update the public Web Store listing or the separate legacy Bean Tab Share tool.
Only `tabs`, `debugger`, and `notifications` permissions are needed; all script execution and
monitoring use CDP. The generic build accepts only `rt1.` codes. BeanOS carries
its one-release 1.1.2 compatibility shim in its distribution during M4 because
that path requires additional deployment-owned GCS/paste-bin hosts. Remove the
shim in 2.1; those hosts never enter this generic build.

Verification: `bun test packages/extension tests/e2e/extension*.test.ts` exercises
fake-CDP enforcement and the real encrypted driver loop. With Playwright and
Chromium installed, run `bun scripts/extension-driver-smoke.mjs` for real CDP
fixture coverage, `bun scripts/privacy-smoke.mjs` for pixel masking, or `bun scripts/extension-smoke.mjs` for the complete installed
extension/server loop. `bun scripts/ledger-media-smoke.mjs` checks real GIF decoding, and
`bun scripts/ledger-page-smoke.mjs` exercises the installed interaction summary UI.
`bun scripts/store-package-smoke.mjs` loads the unpacked store ZIP in Chromium.
The scripts accept `PLAYWRIGHT_MODULE` and
`CHROMIUM_EXECUTABLE` to select locally installed tooling.

The pinned acceptance suite is `bun run test:browser` from the repository root.
It loads the built extension in a persistent Chromium profile and drives the real
AgentSession protocol against local offline fixtures. CI runs it as the separate
`browser` job; only unavailable Chromium permits a reported skip. Use the
[30-minute manual test plan](../../docs/manual-test-plan.md) for real-site MFA,
Chrome UI, expiry, updates, and distribution acceptance, and record its results
before release. A passing automated suite does not replace that human check.


## Handoff attention (2.2.0)

A pending handoff displays the agent's request in an informational, edge-anchored
Remote Tab bar. To acknowledge it, open Remote Tab from the browser toolbar and
choose **Done** in the extension popup. Collapse leaves a persistent button; focusing a field covered
by the bar collapses and moves it to the opposite edge, including after scrolling
or resizing while the field stays focused. Buttons support keyboard
navigation, and the UI has no motion. The action badge/title and a notification
also identify a pending handoff; clicking the notification focuses the shared
tab and its window. Toast display remains subject to OS notification settings.
Explicit Pause stays quiet. Done, Pause, Stop, navigation and expiry clear
attention; a handoff cleared by navigation or Pause remains completable in the
popup. No new host permissions are added.

The bar runs in a Chrome isolated world with a closed shadow root, but the page
still controls the host's visibility, position and stacking. It is therefore
**never a consent surface**: it has no Done button, acknowledgement capability,
CDP binding, or message bridge to the worker. Its buttons only collapse/expand
presentation. Real clicks on a hidden, moved, resized or covered host cannot
complete a handoff. The authoritative Done control lives in the extension-owned
popup, outside page-controlled DOM; badge and notification also live outside it.
A short renewable lease removes orphaned UI within five seconds after
worker/debugger loss, and the session deadline independently expires it. The
banner restores itself while alive as best-effort attention, not as a security
guarantee. Page tampering can suppress that reminder but cannot grant consent.

Navigation performs privacy preflight before moving the tab. If a later
inspection or screenshot mask fails after navigation, the response succeeds
with `navigated: true`, `content_unavailable: "privacy"`, and an extension-owned
`reason`/`message`, omitting page content and screenshots. Redaction limits are
unchanged. A changing embedded-frame geometry regression reproduces this case;
CNN's exact original trigger remains unverified (live access was broker-denied).

The operator reviews/merges and rebuilds the private `remote-tab-2.2.0.zip`.
This display rename does not change extension identity; no store or public
bucket publication is part of this change. See [handoff evidence](../../docs/evidence/handoff/README.md)
and [popup evidence](../../docs/evidence/popup/README.md).
