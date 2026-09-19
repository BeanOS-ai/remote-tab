# Real Chrome acceptance test — 30 minutes

Run this against the unpacked extension and a real running remote-tab server.
The person using Chrome supplies consent and credentials; the person running
the CLI acts as the agent. One person can perform both roles using separate
windows. Automated browser results do not replace the human observations below.
This document is a procedure, not an execution report: all human results start
**NOT RUN**. Fill them only after observing the corresponding behavior.

## Prepare before starting the clock

- Read through the steps once before timing the run. Use Chrome 125 or newer,
  Bun, and this checkout with dependencies installed.
  Prepare two disposable Chrome profiles, A and B, with no personal tabs.
  Branded Google Chrome 137+ ignores `--load-extension`; install manually with
  `chrome://extensions` → **Load unpacked**. Automated extension runs should use
  Chrome for Testing or Chromium.
- Have an approved staging login with a disposable account and working MFA ready.
  Confirm its sign-in flow before the run. A dummy OTP field is **not** evidence
  of completing real MFA. Do not use a production account or real payment data.
- Use one server origin consistently. The commands below use a local server;
  an operator-provided HTTPS server works too if its origin is compiled into the
  extension. Supply an API key privately through the environment only if that
  server requires it. Never paste keys, codes, connection-state files, passwords,
  MFA codes, or raw diagnostic responses into the results table or an issue.
- Start the server and browser fixture in separate terminals and leave them running:

  ```sh
  bun install --frozen-lockfile
  bun run build
  REMOTE_TAB_STORE=memory PORT=8080 bun dist/main.js
  ```

  ```sh
  bun tests/browser/fixture.mjs
  ```

  The fixture must be reachable at `http://127.0.0.1:8081/form` and
  `http://localhost:8081/form`. Use its clean form for ordinary tools and its
  separate privacy page for password/OTP/card checks. These are real HTTP pages;
  neither the extension nor its server transport is mocked.
- Build the unpacked extension for the actual server origin:

  ```sh
  REMOTE_TAB_SERVER_ORIGIN=http://127.0.0.1:8080 bun packages/extension/build.ts
  ```

  HTTP loopback is allowed for development. Do not use the placeholder origin
  or load a differently configured release ZIP.
- Prepare a private CLI state directory. Run these helpers in the agent terminal:

  ```sh
  export REMOTE_TAB_SERVER_URL=http://127.0.0.1:8080
  CLI=packages/cli/src/main.ts
  MANUAL_RUN_DIR=$(mktemp -d)
  chmod 700 "$MANUAL_RUN_DIR"
  rt() { bun "$CLI" "$@" --state "$STATE"; }
  new_share() {
    STATE="$MANUAL_RUN_DIR/$1.json"
    rt create --ttl "${2:-1800}"
  }
  ```

  `new_share NAME SECONDS` prints a private code; paste it only into the
  extension. Each name below is unique because create refuses to overwrite a
  state file. Keep state and exports private. Do not enable terminal recording.
  Codes must be redeemed within **10 minutes** of creation and before session
  expiry; each code works once. Generate a fresh code if setup took longer.

## Clock and results

Start: ______ UTC · End: ______ UTC · Tester: ______

Commit: ______ · Chrome/OS: ______ · Extension version: ______

Server build/store: ______ · Test-login system alias (no account details): ______

Write **PASS**, **FAIL**, or **BLOCKED**, with a short observation. A blocked or
unobserved requirement is not a pass. Stop and record a failure if a command
reaches an unshared tab, reveals a protected value, or continues after local Stop.

| Minutes | Check | Result | Observation / sanitized issue link |
|---|---|---|---|
| 0–3 | Install, consent, malformed and used codes | NOT RUN | |
| 3–9 | All ordinary tools, tab binding, site scope | NOT RUN | |
| 9–12 | Human pause, active ledger, Stop, ZIP/GIF | NOT RUN | |
| 12–15 | Read-only, Full, privacy masking | NOT RUN | |
| 15–20 | Real test-login MFA handoff | NOT RUN | |
| 20–23 | Human Extend, agent denial, 60-second expiry | NOT RUN | |
| 23–25 | ID-only redeem / hijack detection | NOT RUN | |
| 25–28 | Debugger dismissal and unpacked update | NOT RUN | |
| 28–30 | Final results and cleanup | NOT RUN | |

## 0–3: Install, consent, and used-code refusal

1. In profiles A and B, open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked**, and select this checkout's `dist/extension`.
   Record the displayed version; there must be no extension error badge.
2. In profile A, open the clean fixture. Pin/open the extension. Its displayed
   title and URL must identify that exact tab. Default consent must be
   **Read-only** with **This site only** checked.
   No validation message or “Please fill out this field” tooltip should appear
   until **Share this tab** is pressed. Press Share with an empty field and
   expect the same inline invalid-code message as step 3.
3. Paste `rt1.bad` and press **Share this tab**. Expect
   “Paste a valid rt1. code from your agent”; wait two seconds and confirm the
   message remains. No debugger bar or sharing session should appear.
4. Run `new_share act`. Keep its code available privately for step 6. Select
   **Act — click, type, navigate**, leave **This site only** checked, paste the
   code, and click **Share this tab**. **Stop** must remain visible, including
   during startup. Do not touch the shared page while agent tools are running.
5. Run `rt wait-ready --timeout-ms 15000`, then `rt status`. Expect authenticated
   consent with mode `act`, the fixture site, its title/URL, and the extension
   version. Chrome's debugging bar is expected; the popup explains it.
6. In profile B, open the fixture and try the **same still-active code**.
   Expect “This code was already used — tell your agent”, with no lasting
   debugger attachment in B. Profile A must remain the sole controller.
   Do not stop the session until after this check: terminal-code refusal is a
   different case from rejecting a second redeem of an active session.

## 3–9: Every ordinary tool, tab binding, and scope

Use `rt browser_snapshot '{}'` to find the current refs. Replace angle-bracket
refs in the commands below; refs are not selectors and may change after
navigation. Confirm the visible outcome, not merely a successful CLI exit.
Do not send overlapping CLI actions using the same state file.
Browser command failures can be returned as JSON `ok:false` with `error.code`;
inspect that result even if the CLI process itself exits successfully.

| Tool / command | Expected observation |
|---|---|
| `rt browser_snapshot '{}'` | Correct title, URL, accessible form labels, and refs. |
| `rt browser_take_screenshot '{}'` | A screenshot attachment of the shared fixture. Inspect it in the ledger below. |
| `rt browser_hover '{"ref":"<submit-ref>"}'` | Submit gains its purple hover outline; sharing does not pause. |
| `rt browser_type '{"ref":"<name-ref>","text":"Ada Test"}'` | Name field becomes exactly `Ada Test`; Activity omits the typed value. |
| `rt browser_press_key '{"key":"Tab"}'` | Focus moves to the next control; sharing does not pause. |
| `rt browser_select_option '{"ref":"<color-ref>","values":["blue"]}'` | Color becomes Blue. |
| `rt browser_drag '{"startRef":"<drag-ref>","endRef":"<drop-ref>"}'` | The fixture records a completed drag/drop. |
| `rt browser_click '{"ref":"<submit-ref>"}'` | Submit changes the visible fixture status. |
| `rt browser_wait_for '{"text":"Submitted: Ada Test"}'` | Returns when that text is visible. |
| `rt browser_wait_for '{"time":1}'` | Returns after approximately one second. |
| `rt browser_console_messages '{}'` | Fixture diagnostics are returned, or an explicitly empty bounded list. No protected fields have been visited yet. |
| `rt browser_network_requests '{}'` | First click the **Fetch local data** button by ref; `/ping` appears. Credential header values, if present, are redacted. |
| `rt browser_navigate '{"url":"http://127.0.0.1:8081/form?manual=next"}'` | Shared tab reaches the same-site URL. |
| `rt browser_navigate_back '{}'` | Returns to the prior fixture URL. Take a fresh snapshot afterward. |
| `rt browser_evaluate '{"function":"() => document.title"}'` | Refused with `mode_denied` in Act mode. |

Open a second, visibly different tab in profile A and make it active. Without
interacting with the shared fixture, request another screenshot and snapshot.
They must still depict the original shared tab. Return to it via the tab strip.

Try `rt browser_navigate '{"url":"http://localhost:8081/form"}'`.
Expect `scope_denied`, a human-visible notice, and no out-of-scope document
displayed. Test the fixture's **Other host** link too, using its fresh ref with
`browser_click`. Local hosts/IPs compare exactly; changing a port on the same
host is not a sufficient site-scope test. Later, the Full-mode Any-site session
checks that this navigation is permitted when the human authorizes it.

## 9–12: Explicit Pause/Resume, ledger, Stop, and exports

1. Move the real mouse inside the shared page, click, scroll, and type a harmless
   character into its Name field. Sharing must remain active, including while
   working in another tab. Click popup **Pause**. Expect **Paused by you** with
   a UTC timestamp and **Resume**. `rt browser_snapshot '{}'` must return
   `paused`; automation cannot resume merely because the human stops typing.
2. Click popup **Resume**. A new snapshot must succeed. The ledger viewer and
   exported ZIP must include separate local Pause/Resume records with UTC
   timestamps, even if no agent command ran between those controls. Start
   `rt browser_wait_for '{"time":3}'`, then click popup **Pause**
   before it finishes. Expect that command to return `paused`, even if you
   quickly click Resume. It must not publish a successful result/screenshot.
3. Click **View ledger** while active. Wait for **Verified active-session
   snapshot**. Check command/result ordering, human-readable actions, and
   screenshot thumbnails. **Download ZIP** is enabled; **Render GIF** is
   disabled until a terminal snapshot. The page does not silently refresh.
4. Click popup **Stop**. Debugger control must detach immediately and an
   installed `chrome-extension://…/ledger.html` page must open. Expect verified
   stopped history. `rt browser_click '{"ref":"<submit-ref>"}'` must fail;
   the visible form must not change. `rt status` must report `stopped`.
5. On the terminal ledger, click **Download ZIP**, **Render GIF**, then
   **Download GIF**. Open the ZIP and GIF. Expect `ledger.json`, PNGs under
   `shots/`, readable screenshots of the shared tab, and a 640×360 replay at
   one screenshot per second. No server-hosted ledger or media service opens.
   Render/download again and compare file hashes if time permits; identical
   history must produce identical GIF bytes.
6. Run `rt ledger export --out "$MANUAL_RUN_DIR/act-export"`. It must verify
   the history and export JSON/PNGs without overwriting an existing export.
   Compare its final sequence/hash with the popup ZIP's ledger. The CLI's
   `ledger render` is currently unsupported; GIF acceptance uses the extension.

## 12–15: Read-only, Full, and protected data

1. Run `new_share read`; share the clean form with **Read-only**. Wait ready.
   Snapshot and screenshot must work. Exercise every acting-tool denial:

   ```sh
   for tool in browser_click browser_type browser_press_key browser_hover \
     browser_select_option browser_drag browser_navigate browser_navigate_back \
     browser_wait_for browser_evaluate; do
     rt "$tool" '{}'
   done
   ```

   Each must return `mode_denied` before inspecting action arguments, and the
   form must remain unchanged. Run `rt stop` and
   confirm agent-initiated Stop also detaches Chrome.
2. Run `new_share full`; share the clean form with **Full — scripting access**
   and **This site only** unchecked. Wait ready. Run
   `rt browser_evaluate '{"function":"() => ({title:document.title,check:7})"}'`.
   Expect the fixture title and `check:7`. Navigate to
   `http://localhost:8081/form`; it must succeed in this Any-site session.
3. Navigate to `http://localhost:8081/privacy`. Human-enter conspicuous **dummy**
   password, OTP, and card values after clicking **Pause**. Resume using
   the popup, then request a snapshot and screenshot. Values must be absent
   from text/results and their field regions must be masked in the ledger.
   Embedded frames, if present, must be masked as whole frames.
4. Console, network, and evaluate must now return `privacy_denied`. Return to
   the clean form and repeat evaluate: it must remain refused for this share.
   Stop and inspect its ledger for dummy-value leaks, including action labels.

## 15–20: Real MFA handoff

1. Run `new_share mfa`. Open the approved staging login in profile A and share
   with **Act** and the scope required by that login's redirects. Wait ready.
   If the site is refused because protected-field inspection cannot run safely, record **BLOCKED** and the site's alias. Do not disable
   the guard, reload away form state, or substitute a dummy OTP as a pass.
2. Run the following and leave it waiting:

   ```sh
   rt handoff '{"message":"Please complete test sign-in and MFA, then click Done."}' --timeout-ms 240000
   ```

3. Expect **Your turn**, the exact message, and **Done**. **Resume** must not
   replace Done. In another agent terminal using the same state path, request
   one snapshot with a short timeout; the shared client must refuse it as
   `handoff_pending` before sending it. A command already delivered at the
   boundary may instead return `paused`. Avoid further concurrent commands.
4. The human enters the test password and current MFA response directly into
   the website and reaches the authenticated landing page. Do not copy either
   credential into a command, screenshot report, terminal, or chat.
5. Click **Done**. The waiting handoff must complete, then a new snapshot must
   show the authenticated landing page. Stop and verify the ledger includes
   the handoff and completion. Record only success/failure, no credential or
   account-identifying page contents. A rejected/missing MFA step is not a pass.

## 20–23: Short TTL, human-only Extend, and expiry

1. Run `new_share extend 60`, share the clean form promptly, and wait ready.
   **Extend 30 minutes** must already be visible because expiry is within five
   minutes. Record the expiry from `rt status`, click Extend, and run status
   again. Expect exactly +1800 seconds and the Extend button to disappear.
   The session must survive its original 60-second deadline.
2. Verify agent credentials cannot extend, without printing those credentials:

   ```sh
   MANUAL_STATE="$STATE" bun -e '
   const s = await Bun.file(process.env.MANUAL_STATE).json();
   const r = await fetch(`${s.serverUrl}/v1/sessions/${s.sessionId}/extend`, {
     method: "POST", headers: {Authorization: `Bearer ${s.agentToken}`}
   });
   console.log({status:r.status}); await r.body?.cancel();'
   ```

   Expect HTTP 403. Stop this session after checking the original deadline.
3. Run `new_share expire 60`, share promptly, and wait ready. Do **not** Extend.
   Leave it idle until the actual expiry timestamp (not just the rounded popup
   minute count). Expect local detachment, no further actions, and `expired`
   from `rt status`. Open its ledger and confirm verified expired history.

## 23–25: ID-only redeemer / hijack suspicion

Use only this disposable test session. This simulates someone who learned the
session ID, not a thief who stole the full private code.

```sh
new_share hijack 60
MANUAL_STATE="$STATE" bun -e '
const s = await Bun.file(process.env.MANUAL_STATE).json();
const r = await fetch(`${s.serverUrl}/v1/sessions/${s.sessionId}/redeem`, {method:"POST"});
console.log({status:r.status}); await r.body?.cancel();'
rt wait-ready --timeout-ms 20000
rt status
```

Do not paste this code into the extension. The synthetic redeemer sends only
the ID, discards the returned browser credential, and sends no hello. Expect
redeem HTTP 200, then `hijack_suspected` after the hello grace period and a
stopped session. No browser command should execute. This does **not** prove
detection of full-code theft: a thief with the full code can authenticate.

## 25–28: Debugger bar, loss of control, and unpacked update

1. Run `new_share detach 60`, share the clean form, and wait ready. Dismiss
   Chrome's debugging bar using its own Cancel/close control. Expect sharing
   to end locally, the popup to stop offering live control, and a subsequent
   agent action to fail. Do not interpret a missing debugger bar as permission
   to continue. Stop the agent session explicitly if its transport still exists.
2. Run `new_share update 60`, share, and wait ready. For a reproducible local
   unpacked update, increment only the generated manifest's patch version:

   ```sh
   bun -e '
   const path="dist/extension/manifest.json";
   const m=await Bun.file(path).json();
   const parts=m.version.split(".").map(Number);
   parts[parts.length-1]++; m.version=parts.join(".");
   await Bun.write(path,JSON.stringify(m,null,2));'
   ```

   In `chrome://extensions`, click **Reload** for this unpacked extension.
   Confirm the new displayed version, the old debugger attachment is gone,
   and reopening the popup requires a fresh code/consent. The old share must
   not resume or replay commands. End its transport using `rt stop`.
3. Create `new_share after-update 60`, consent again, and verify one snapshot
   succeeds; then Stop. This checks the unpacked update/restart lifecycle,
   not Chrome Web Store delivery. Do not publish the locally incremented build.
   Rebuild the extension afterward to restore the source version.

## 28–30: Close the run

- Fill every results row, including any skipped tool or blocked real-login step.
  Record durations and sanitized error codes. Do not mark the whole run passed
  when any required observation is missing.
- Keep only reviewed dummy-fixture exports as evidence. Do not attach the MFA
  ledger, connection-state files, private codes, browser tokens, or raw console
  logs. Privately inspect any suspected leak and report the affected surface,
  not the value.
- Confirm every session is stopped or expired, sign out of the test account,
  close the disposable profiles, and stop the fixture/server terminals. Delete
  private state and exports according to the test environment's cleanup policy.
- If a step exceeded its budget, record **BLOCKED: time budget** and the last
  completed observation. Do not silently omit it or claim a 30-minute pass.

Overall: **NOT RUN** → PASS / FAIL / BLOCKED ______

Outstanding observations / sanitized issue links: __________________________
