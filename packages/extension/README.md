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


Load `dist/extension` using **Load unpacked** on `chrome://extensions` (Developer
mode). Chrome 125+ is required. Open a normal HTTP(S) tab, paste the private code,
choose the access mode and site scope, then **Share this tab**. Stop immediately
detaches Chrome's debugger, even if the server is unreachable. Closing the tab,
losing debugger control, expiry, or a transport integrity error ends local control.
A browser/worker restart requires a new code and fresh consent; actions are never
replayed from saved state.

Site scope uses the complete vendored Public Suffix List, including private
suffixes. The data keeps its upstream MPL-2.0 license; extension code is MIT.
Screenshots always use the attached target via CDP, never the active window.
Large snapshots travel as encrypted JSON attachments under the protocol's
message ceiling. Network inspection always redacts credential headers.

The popup shows recent actions, Stop, Extend near expiry, handoff Done, and
Resume after human input pauses sharing. Pages with preexisting window capture
handlers that could suppress takeover detection are refused; the extension does
not reload the page or discard form state. An interrupted command remains paused
even if the human quickly resumes. Chrome’s debugging bar is expected.

Password, one-time-code, and payment-card fields are scrubbed from results and
masked locally in screenshots; embedded frames are masked in full. Full-mode
scripting and console/network inspection are refused for the rest of a share
once protected fields or uninspected frames are encountered. Diagnostic buffers
are discarded at that boundary.
If privacy inspection or screenshot geometry validation fails, no result or
image is sent. Session-only redaction state is never persisted.

Stop opens an installed ledger page automatically. **View ledger** opens an
immutable snapshot while sharing. The worker decrypts and verifies using the
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
32 MiB of metadata; pending transfers expire after five minutes. Store packaging
follows in the final M3 change.


Verification: `bun test packages/extension tests/e2e/extension*.test.ts` exercises
fake-CDP enforcement and the real encrypted driver loop. With Playwright and
Chromium installed, run `bun scripts/extension-driver-smoke.mjs` for real CDP
fixture coverage, `bun scripts/privacy-smoke.mjs` for pixel masking, or `bun scripts/extension-smoke.mjs` for the complete installed
extension/server loop. `bun scripts/ledger-media-smoke.mjs` checks real GIF decoding, and
`bun scripts/ledger-page-smoke.mjs` exercises the installed ledger UI.
The scripts accept `PLAYWRIGHT_MODULE` and
`CHROMIUM_EXECUTABLE` to select locally installed tooling.
