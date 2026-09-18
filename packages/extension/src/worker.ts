import { RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { type Sender, record } from "./chrome";
import { TabDriver } from "./driver";
import { siteForUrl } from "./scope";
import { SharedSession } from "./session";

let active: SharedSession | undefined;
let tabId: number | undefined;
let starting = false;
let driver: TabDriver | undefined;
function trusted(sender: Sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}
async function handle(message: unknown) {
  if (!record(message)) throw new Error("Invalid request");
  if (message.action === "state") {
    if (active?.state.sharing && tabId !== undefined) {
      const tab = await chrome.tabs.get(tabId);
      active.state.url = tab.url;
      active.state.title = tab.title;
    }
    return active?.state ?? { sharing: false };
  }
  if (message.action === "stop") {
    await active?.stop();
    return { ok: true };
  }
  if (message.action !== "share") throw new Error("Unknown request");
  if (starting || active?.state.sharing) throw new Error("A tab is already shared");
  if (typeof message.code !== "string" || !parseCode(message.code))
    throw new Error("Paste a valid rt1. code from your agent");
  if (
    !["read", "act", "full"].includes(String(message.mode)) ||
    typeof message.siteOnly !== "boolean"
  )
    throw new Error("Choose a mode and site scope");
  starting = true;
  let attached = false;
  let selectedId: number | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url))
      throw new Error("Choose a normal HTTP or HTTPS tab");
    selectedId = tab.id;
    const target = { tabId: selectedId };
    const mode = message.mode as "read" | "act" | "full";
    const scope = message.siteOnly ? siteForUrl(tab.url) : null;
    tabId = selectedId;
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const newDriver = new TabDriver(
      (method, params) => chrome.debugger.sendCommand(target, method, params),
      {
        mode,
        scope,
        url: tab.url,
        title: tab.title ?? "",
        onNotice: (notice: { code: string; message: string }) => {
          if (active) active.state.notice = notice.message;
          if (notice.code === "scope_lost") void active?.stop();
        },
      },
    );
    driver = newDriver;
    await newDriver.initialize();
    const current = await chrome.tabs.get(selectedId);
    if (current.url !== tab.url)
      throw new Error("The tab changed while sharing started. Try again.");
    active = await SharedSession.connect({
      code: message.code,
      serverUrl: REMOTE_TAB_SERVER_ORIGIN,
      driver: newDriver,
      hello: {
        mode,
        scope,
        url: tab.url,
        title: tab.title,
        extension_version: chrome.runtime.getManifest().version,
      },
      detach: () => chrome.debugger.detach(target),
    });
    return { ok: true };
  } catch (error) {
    if (attached && selectedId !== undefined)
      await chrome.debugger.detach({ tabId: selectedId }).catch(() => {});
    driver = undefined;
    tabId = undefined;
    if (error instanceof RemoteTabError && error.code === "already_redeemed")
      throw new Error("This code was already used — tell your agent");
    throw error;
  } finally {
    starting = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender)) return undefined;
  void handle(message).then(respond, (error) =>
    respond({
      ok: false,
      error:
        error instanceof Error && !(error instanceof RemoteTabError)
          ? error.message
          : "Could not connect. Ask your agent for a new code.",
    }),
  );
  return true;
});
chrome.debugger.onEvent.addListener((target, method, params) => {
  if (target.tabId !== tabId || !driver) return;
  void driver.onEvent(method, params ?? {}).catch(() => active?.stop());
});
chrome.debugger.onDetach.addListener((target) => {
  if (target.tabId === tabId) void active?.stop();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) void active?.stop();
});
