import { RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { type Sender, record } from "./chrome";
import { DriverError, TabDriver } from "./driver";
import { LedgerJobs } from "./ledger-data";
import { PrivacyGuard } from "./privacy";
import { siteForUrl } from "./scope";
import { SharedSession } from "./session";
import { TakeoverError, TakeoverMonitor } from "./takeover";

const ledgers = new LedgerJobs();
let active: SharedSession | undefined;
async function openLedger(share: SharedSession, settled?: Promise<void>) {
  const jobId = ledgers.create(share.peer, settled);
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`ledger.html#${jobId}`) });
  } catch {
    ledgers.release(jobId);
    throw new Error("Could not open the ledger. Try again from the popup.");
  }
}
function ledgerRequest(message: Record<string, unknown>) {
  if (typeof message.jobId !== "string") throw new Error("Invalid ledger request");
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
    throw new Error("Invalid ledger request");
  return ledgers.chunk(id, message.kind, message.offset, message.entry, message.attachment);
}
let tabId: number | undefined;
let starting = false;
let attempt: { cancelled: boolean } | undefined;
function cancelStart() {
  if (attempt) attempt.cancelled = true;
}
let driver: TabDriver | undefined;
let monitor: TakeoverMonitor | undefined;
let detaching = 0;
async function detachAfterCleanup(id: number, takeover?: TakeoverMonitor) {
  detaching++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (takeover) {
      // Sharing is already revoked synchronously. Give our capture listeners a
      // bounded chance to disappear before detaching invalidates their CDP calls.
      await Promise.race([
        takeover.dispose().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    }
  } finally {
    clearTimeout(timer);
    try {
      await chrome.debugger.detach({ tabId: id });
    } finally {
      detaching--;
    }
  }
}
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
    return { ...(active?.state ?? { sharing: false }), starting };
  }
  if (message.action === "open-ledger") {
    if (!active) throw new Error("No session history is available in this worker");
    await openLedger(active);
    return { ok: true };
  }
  if (message.action === "stop") {
    cancelStart();
    if (starting && tabId !== undefined) await detachAfterCleanup(tabId, monitor).catch(() => {});
    await active?.stop();
    return { ok: true };
  }
  if (["resume", "done", "extend"].includes(String(message.action))) {
    if (!active?.state.sharing) throw new Error("Sharing has ended");
    if (message.action === "resume") active.resume();
    if (message.action === "done") await active.done();
    if (message.action === "extend") {
      try {
        await active.extend();
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
  if (detaching) throw new Error("Sharing is stopping. Try again shortly.");
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
  const pending = { cancelled: false, paused: false };
  attempt = pending;
  let attached = false;
  let selectedId: number | undefined;
  let boundShare: SharedSession | undefined;
  let newMonitor: TakeoverMonitor | undefined;
  try {
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
    const takeover = new TakeoverMonitor(rawCdp, () => {
      pending.paused = true;
      boundShare?.pause();
    });
    newMonitor = takeover;
    monitor = takeover;
    await takeover.initialize();
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
      if (boundShare?.interrupted && !maintenance)
        throw new DriverError("paused", "Paused: you took over");
      // These lifecycle barriers also run between old and new document worlds.
      if (maintenance) return rawCdp(method, params);
      return takeover.dispatch(method, params).catch((error) => {
        if (error instanceof TakeoverError) {
          pending.cancelled = true;
          if (boundShare) boundShare.state.notice = error.message;
          void boundShare?.stop();
        }
        throw error;
      });
    };
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
      isPaused: () => pending.paused,
      isCancelled: () => pending.cancelled,
      onStop: (share, settled) => {
        void openLedger(share, settled).catch(() => {
          share.state.notice =
            "Sharing stopped. Open the ledger from the popup to save your history.";
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
      detach: () => detachAfterCleanup(target.tabId, takeover),
    });
    active = boundShare;
    return { ok: true };
  } catch (error) {
    if (attached && selectedId !== undefined)
      await detachAfterCleanup(selectedId, newMonitor).catch(() => {});
    else void newMonitor?.dispose();
    driver = undefined;
    tabId = undefined;
    if (error instanceof RemoteTabError && error.code === "already_redeemed")
      throw new Error("This code was already used — tell your agent");
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
      error:
        error instanceof Error && !(error instanceof RemoteTabError)
          ? error.message
          : "Could not connect. Ask your agent for a new code.",
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
  void monitor?.onEvent(method, params ?? {}, target.sessionId).catch(failed);
  if (!target.sessionId) void driver?.onEvent(method, params ?? {}).catch(failed);
});
chrome.debugger.onDetach.addListener((target) => {
  if (target.tabId === tabId) {
    cancelStart();
    void monitor?.dispose();
    void active?.stop();
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) {
    cancelStart();
    void monitor?.dispose();
    void active?.stop();
  }
});
