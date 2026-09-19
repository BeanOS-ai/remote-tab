import { parseCode } from "@remote-tab/protocol";
import { record } from "./chrome";
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const error = element("error");
let consentTab: { id?: number; url?: string; title?: string } | undefined;
let submitting = false;
let notice = "";
let feedText = "";
for (const input of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) {
  input.onchange = () => {
    if (input.checked)
      element("share-label").textContent =
        input.value === "read" ? "Read my tab" : "Control my tab";
  };
}
async function render() {
  const [state, [tab]] = await Promise.all([
    chrome.runtime.sendMessage({ action: "state" }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  if (!record(state)) return;
  consentTab = tab;
  const sharing = state.sharing === true;
  const tabMissing = sharing && state.tabMissing === true;
  const otherTab = sharing && typeof state.tabId === "number" && state.tabId !== tab?.id;
  element("open-ledger").hidden = typeof state.sessionId !== "string";
  const starting = state.starting === true || submitting;
  const handoff = record(state.handoff) ? state.handoff : undefined;
  const paused = state.paused === true;
  const badge = element("share-status");
  badge.textContent = starting
    ? "Connecting…"
    : sharing
      ? tabMissing
        ? "Shared tab closed"
        : handoff
          ? "Your turn"
          : paused
            ? "Paused"
            : "Sharing"
      : "Ready to share";
  badge.dataset.state = sharing
    ? tabMissing || paused || handoff
      ? "paused"
      : "sharing"
    : "ready";
  element("consent").hidden = sharing || starting;
  element("live").hidden = !sharing;
  element<HTMLButtonElement>("stop").disabled = !sharing && !starting;
  const access =
    state.mode === "read"
      ? "Read-only"
      : state.mode === "act"
        ? "Agent can click and type"
        : "Agent can run scripts";
  element("state").textContent = tabMissing
    ? "No agent access: shared tab closed."
    : `${access} · ${state.scope ? `${state.scope} only` : "Any site"}`;
  element("tab-label").textContent = sharing ? "SHARED TAB" : "THIS TAB";
  let origin = "Site unavailable";
  if (typeof state.url === "string") {
    try {
      const url = new URL(state.url);
      origin = url.origin === "null" ? "Local page" : url.origin;
    } catch {
      // A tab can disappear or navigate while its state is being read.
    }
  }
  element("tab").textContent = sharing
    ? `${state.title || "Untitled tab"}\n${origin}`
    : `${tab?.title ?? ""}\n${tab?.url ?? ""}`;
  element("shared-tab-status").hidden = !tabMissing && !otherTab;
  element("shared-tab-status").textContent = tabMissing
    ? "The shared tab is closed. Use Stop to end this share."
    : "You’re viewing a different tab.";
  element("focus-shared").hidden = !otherTab || tabMissing;
  const remaining =
    typeof state.expiresAt === "string" ? Date.parse(state.expiresAt) - Date.now() : 0;
  element("expiry").textContent = `Ends in ${Math.max(0, Math.ceil(remaining / 60000))} minutes`;
  element("expiry").hidden = tabMissing;
  element("extend").hidden =
    !sharing || tabMissing || state.extended === true || remaining > 5 * 60_000;
  element("handoff").hidden = !handoff || tabMissing;
  element("handoff-message").textContent = String(handoff?.message ?? "");
  element("paused").hidden = !sharing || tabMissing || state.paused !== true || !!handoff;
  element("pause").hidden = !sharing || tabMissing || paused || !!handoff;
  const actions = Array.isArray(state.actions) ? state.actions.map(String) : [];
  if (JSON.stringify(actions) !== feedText) {
    feedText = JSON.stringify(actions);
    element("feed").replaceChildren(
      ...actions
        .slice(-20)
        .reverse()
        .map((text) => {
          const li = document.createElement("li");
          li.textContent = text;
          return li;
        }),
    );
  }
  const nextNotice = String(state.notice ?? "");
  if (nextNotice !== notice) {
    notice = nextNotice;
    error.textContent = notice;
  }
}
element<HTMLFormElement>("consent").onsubmit = async (event) => {
  event.preventDefault();
  const field = element<HTMLInputElement>("code");
  const code = field.value.trim();
  if (!parseCode(code)) {
    error.textContent = "Paste a valid rt1. code from your agent";
    return;
  }
  const button = element<HTMLButtonElement>("share");
  button.disabled = true;
  error.textContent = "";
  submitting = true;
  const mode = (document.querySelector("input[name=mode]:checked") as HTMLInputElement).value;
  field.value = "";
  // The Stop control remains available while redemption is in flight.
  element<HTMLButtonElement>("stop").disabled = false;
  try {
    const response = await chrome.runtime.sendMessage({
      action: "share",
      tabId: consentTab?.id,
      url: consentTab?.url,
      code,
      mode,
      siteOnly: element<HTMLInputElement>("site").checked,
    });
    submitting = false;
    await render();
    if (record(response) && response.ok === false) error.textContent = String(response.error);
  } catch {
    error.textContent = "Could not start sharing";
  } finally {
    button.disabled = false;
    submitting = false;
  }
};
for (const action of ["stop", "pause", "extend", "done", "resume", "open-ledger", "focus-shared"]) {
  element<HTMLButtonElement>(action).onclick = async () => {
    const button = element<HTMLButtonElement>(action);
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action });
      await render();
      if (record(response) && response.ok === false) error.textContent = String(response.error);
    } catch {
      error.textContent = "Could not update sharing";
    } finally {
      if (action !== "stop") button.disabled = false;
    }
  };
}
void render().catch(() => {
  error.textContent = "Sharing is unavailable. Reopen the popup.";
});
setInterval(
  () =>
    void render().catch(() => {
      error.textContent = "Sharing is unavailable. Reopen the popup.";
    }),
  1000,
);
