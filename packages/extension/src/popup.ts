import { parseCode } from "@remote-tab/protocol";
import { record } from "./chrome";
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const error = element("error");
async function render() {
  const state = await chrome.runtime.sendMessage({ action: "state" });
  if (!record(state)) return;
  const sharing = state.sharing === true;
  element("consent").hidden = sharing;
  element("live").hidden = !sharing;
  element("state").textContent =
    `Sharing in ${state.mode} mode. ${state.scope ? `Site: ${state.scope}` : "Any site"}`;
  if (sharing) element("tab").textContent = `${state.title ?? ""}\n${state.url ?? ""}`;
  if (state.notice) error.textContent = String(state.notice);
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
  const mode = (document.querySelector("input[name=mode]:checked") as HTMLInputElement).value;
  field.value = "";
  try {
    const response = await chrome.runtime.sendMessage({
      action: "share",
      code,
      mode,
      siteOnly: element<HTMLInputElement>("site").checked,
    });
    if (record(response) && response.ok === false) error.textContent = String(response.error);
    await render();
  } catch {
    error.textContent = "Could not start sharing";
  } finally {
    button.disabled = false;
  }
};
element("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ action: "stop" });
  await render();
};
void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  element("tab").textContent = `${tab?.title ?? ""}\n${tab?.url ?? ""}`;
});
void render();
setInterval(() => void render(), 1000);
