import { RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { type Sender, type Tab, record } from "./chrome";
import { DriverError, TabDriver } from "./driver";
import { HANDOFF_NOTIFICATION, HandoffAttention, clearAttentionChrome } from "./handoff-attention";
import { LedgerJobs } from "./ledger-data";
import { popupError } from "./popup-error";
import { PrivacyGuard } from "./privacy";
import { siteForUrl } from "./scope";
import { SharedSession } from "./session";

const ledgers = new LedgerJobs();
let active: SharedSession | undefined;
let attention: HandoffAttention | undefined;
const startupAttention = clearAttentionChrome();
async function openLedger(share: SharedSession, settled?: Promise<void>) {
  const jobId = ledgers.create(share.peer, settled, share.controlEvents);
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`ledger.html#${jobId}`) });
  } catch {
    ledgers.release(jobId);
    throw new Error("Could not open the interaction summary. Try again from the popup.");
  }
}
function ledgerRequest(message: Record<string, unknown>) {
  if (typeof message.jobId !== "string") throw new Error("Invalid interaction summary request");
  const id = message.jobId;
  if (message.action === "ledger-status") return ledgers.status(id);
  if (message.action === "ledger-release") {
    ledgers.release(id);
    return { ok: true };
  }
  if (
    message.action !== "ledger-chunk" ||
    (message.kind !== "metadata" && message.kind !== "attachment") ||
    typeof message.offset !== "number" ||
    (message.entry !== undefined && typeof message.entry !== "number") ||
    (message.attachment !== undefined && typeof message.attachment !== "number")
  )
    throw new Error("Invalid interaction summary request");
  return ledgers.chunk(id, message.kind, message.offset, message.entry, message.attachment);
}
let tabId: number | undefined;
let starting = false;
let attempt: { cancelled: boolean } | undefined;
function cancelStart() {
  if (attempt) attempt.cancelled = true;
}
let driver: TabDriver | undefined;
function trusted(sender: Sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}
async function focusSharedTab() {
  if (!active?.state.sharing || tabId === undefined) throw new Error("No tab is being shared");
  let tab: Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("The shared tab was closed. Stop this share to continue.");
  }
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}
async function handle(message: unknown) {
  if (!record(message)) throw new Error("Invalid request");
  if (message.action === "focus-shared") return focusSharedTab();
  if (message.action === "state") {
    let tabMissing = false;
    let windowId: number | undefined;
    if (active?.state.sharing && tabId !== undefined) {
      try {
        const tab = await chrome.tabs.get(tabId);
        active.state.url = tab.url;
        active.state.title = tab.title;
        windowId = tab.windowId;
      } catch {
        tabMissing = true;
      }
    }
    return { ...(active?.state ?? { sharing: false }), starting, tabId, windowId, tabMissing };
  }
  if (message.action === "open-ledger") {
    if (!active) throw new Error("No session history is available in this worker");
    await openLedger(active);
    return { ok: true };
  }
  if (message.action === "stop") {
    cancelStart();
    if (starting && tabId !== undefined) await chrome.debugger.detach({ tabId }).catch(() => {});
    await active?.stop();
    return { ok: true };
  }
  if (["pause", "resume", "done", "extend"].includes(String(message.action))) {
    if (!active?.state.sharing) throw new Error("Sharing has ended");
    if (message.action === "pause") active.pause();
    if (message.action === "resume") {
      active.resume();
    }
    if (message.action === "done") await active.done();
    if (message.action === "extend") {
      try {
        await active.extend();
        await attention?.extend(active.state.expiresAt ?? "");
      } catch (error) {
        if (error instanceof RemoteTabError && error.code === "ttl_exceeded")
          throw new Error("This share has reached its 60-minute limit");
        throw error;
      }
    }
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
  if (
    typeof message.tabId !== "number" ||
    !Number.isInteger(message.tabId) ||
    typeof message.url !== "string"
  )
    throw new Error("Reopen the popup to choose a tab");
  starting = true;
  const pending = { cancelled: false };
  attempt = pending;
  let attached = false;
  let selectedId: number | undefined;
  let boundShare: SharedSession | undefined;
  try {
    await startupAttention;
    await attention?.clear();
    const tab = await chrome.tabs.get(message.tabId);
    if (tab.id !== message.tabId || tab.url !== message.url)
      throw new Error("The tab changed. Reopen the popup to confirm sharing.");
    if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url))
      throw new Error("Choose a normal HTTP or HTTPS tab");
    selectedId = tab.id;
    const target = { tabId: selectedId };
    const mode = message.mode as "read" | "act" | "full";
    const scope = message.siteOnly ? siteForUrl(tab.url) : null;
    tabId = selectedId;
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const rawCdp = (method: string, params?: Record<string, unknown>, sessionId?: string) =>
      chrome.debugger.sendCommand(
        { ...target, ...(sessionId ? { sessionId } : {}) },
        method,
        params,
      );
    const cdp = (method: string, params?: Record<string, unknown>) => {
      if (pending.cancelled || boundShare?.state.sharing === false)
        throw new DriverError("stopped", "Sharing stopped");
      // Scope interception must continue while the human browses during a pause.
      const maintenance = [
        "Fetch.continueRequest",
        "Fetch.failRequest",
        "Page.handleJavaScriptDialog",
        "Page.stopLoading",
      ].includes(method);
      if (boundShare?.interrupted && !maintenance) throw new DriverError("paused", "Paused by you");
      return rawCdp(method, params);
    };
    const newAttention = new HandoffAttention(rawCdp);
    attention = newAttention;
    const privacy = new PrivacyGuard(cdp);
    await privacy.scan();
    const newDriver = new TabDriver(cdp, {
      privacy,
      mode,
      scope,
      url: tab.url,
      title: tab.title ?? "",
      onNotice: (notice: { code: string; message: string }) => {
        if (active) active.state.notice = notice.message;
        if (notice.code === "scope_lost") {
          cancelStart();
          void active?.stop();
        }
      },
    });
    driver = newDriver;
    await newDriver.initialize();
    const current = await chrome.tabs.get(selectedId);
    if (current.url !== tab.url)
      throw new Error("The tab changed while sharing started. Try again.");
    if (pending.cancelled) throw new Error("Sharing cancelled");
    boundShare = await SharedSession.connect({
      isCancelled: () => pending.cancelled,
      onHandoff: (handoff, expiresAt) => {
        if (handoff) newAttention.show(handoff.message, expiresAt);
        else return newAttention.clear();
      },
      onStop: (share, settled) => {
        void openLedger(share, settled).catch(() => {
          share.state.notice =
            "Sharing stopped. Open the interaction summary from the popup to save your history.";
        });
      },
      code: message.code,
      serverUrl: REMOTE_TAB_SERVER_ORIGIN,
      fetch: globalThis.fetch.bind(globalThis),
      driver: newDriver,
      hello: {
        mode,
        scope,
        url: privacy.sanitize(tab.url) as string,
        title: privacy.sanitize(tab.title ?? "") as string,
        extension_version: chrome.runtime.getManifest().version,
      },
      detach: async () => {
        await newAttention.clear();
        await chrome.debugger.detach(target);
      },
    });
    active = boundShare;
    return { ok: true };
  } catch (error) {
    await attention?.clear();
    if (attached && selectedId !== undefined)
      await chrome.debugger.detach({ tabId: selectedId }).catch(() => {});
    driver = undefined;
    tabId = undefined;
    throw error;
  } finally {
    starting = false;
    if (attempt === pending) attempt = undefined;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const ledger =
    record(message) &&
    typeof message.jobId === "string" &&
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL(`ledger.html#${message.jobId}`) &&
    ["ledger-status", "ledger-chunk", "ledger-release"].includes(String(message.action));
  if (!trusted(sender) && !ledger) return undefined;
  const operation = ledger
    ? Promise.resolve().then(() => ledgerRequest(message as Record<string, unknown>))
    : handle(message);
  void operation.then(respond, (error) =>
    respond({
      ok: false,
      error: popupError(error),
    }),
  );
  return true;
});
chrome.debugger.onEvent.addListener((target, method, params) => {
  if (target.tabId !== tabId) return;
  const failed = () => {
    if (active?.state.sharing)
      active.state.notice = "Sharing ended because this page could no longer be controlled safely";
    cancelStart();
    return active?.stop();
  };
  if (!target.sessionId) {
    // Clear attention before any document transition, including same-document navigation.
    if (
      (method === "Page.frameNavigated" && record(params?.frame) && !params.frame.parentId) ||
      (method === "Page.navigatedWithinDocument" && driver?.isMainFrame(params?.frameId))
    )
      void attention?.clear();
    void driver?.onEvent(method, params ?? {}).catch(failed);
  }
});
chrome.debugger.onDetach.addListener((target) => {
  if (target.tabId === tabId) {
    cancelStart();
    void active?.stop();
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) {
    cancelStart();
    void active?.stop();
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === HANDOFF_NOTIFICATION && active?.state.handoff) void focusSharedTab().catch(() => {});
});
