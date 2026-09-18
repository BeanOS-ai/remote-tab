import { parseCode } from "@remote-tab/protocol";
import { record } from "./chrome";
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const error = element("error");
let consentTab: { id?: number; url?: string } | undefined;
let submitting = false;
let notice = "";
let feedText = "";
async function render() {
  const state = await chrome.runtime.sendMessage({ action: "state" });
  if (!record(state)) return;
  const sharing = state.sharing === true;
  const starting = state.starting === true || submitting;
  element("consent").hidden = sharing || starting;
  element("live").hidden = !sharing;
  element<HTMLButtonElement>("stop").disabled = !sharing && !starting;
  element("state").textContent =
    `Sharing in ${state.mode} mode. ${state.scope ? `Site: ${state.scope}` : "Any site"}`;
  if (sharing) element("tab").textContent = `${state.title ?? ""}\n${state.url ?? ""}`;
  const remaining =
    typeof state.expiresAt === "string" ? Date.parse(state.expiresAt) - Date.now() : 0;
  element("expiry").textContent = `Ends in ${Math.max(0, Math.ceil(remaining / 60000))} minutes`;
  element("extend").hidden = !sharing || state.extended === true || remaining > 5 * 60_000;
  const handoff = record(state.handoff) ? state.handoff : undefined;
  element("handoff").hidden = !handoff;
  element("handoff-message").textContent = String(handoff?.message ?? "");
  element("paused").hidden = !sharing || state.paused !== true || !!handoff;
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
for (const action of ["stop", "extend", "done", "resume"]) {
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
void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  consentTab = tab;
  element("tab").textContent = `${tab?.title ?? ""}\n${tab?.url ?? ""}`;
});
void render();
setInterval(
  () =>
    void render().catch(() => {
      error.textContent = "Sharing is unavailable. Reopen the popup.";
    }),
  1000,
);
