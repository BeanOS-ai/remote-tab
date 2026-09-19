import type { Cdp } from "./driver";
import { mountHandoff } from "./handoff-overlay";

export const HANDOFF_NOTIFICATION = "remote-tab-handoff";
export const DEFAULT_TITLE = "Remote Tab";
export async function clearAttentionChrome() {
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title: DEFAULT_TITLE }),
    chrome.notifications.clear(HANDOFF_NOTIFICATION),
  ]);
}
/** One consented tab's attention UI. Revocation is synchronous; rendering and
 * cleanup serialize so a late installation cannot leak into a later handoff. */
export class HandoffAttention {
  private epoch = 0;
  private expiresAt = 0;
  private wanted?: { id: string; token: string; context?: number };
  private objectId?: string;
  private binding?: string;
  private queue: Promise<void> = Promise.resolve();
  private refresh?: ReturnType<typeof setInterval>;
  constructor(
    private readonly cdp: Cdp,
    private readonly done: (id: string) => Promise<void>,
  ) {}
  show(id: string, message: string, expiresAt: string): void {
    const epoch = ++this.epoch;
    this.expiresAt = Date.parse(expiresAt);
    const wanted = { id, token: crypto.randomUUID(), context: undefined as number | undefined };
    this.wanted = wanted;
    this.queue = this.queue
      .then(async () => {
        await this.remove();
        if (epoch !== this.epoch) return;
        await Promise.allSettled([
          chrome.action.setBadgeBackgroundColor({ color: "#b9f4aa" }),
          chrome.action.setBadgeText({ text: "!" }),
          chrome.action.setTitle({ title: "Remote Tab — your turn: your agent is waiting" }),
          chrome.notifications.create(HANDOFF_NOTIFICATION, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Remote Tab — your turn",
            message: "Your agent is waiting. Click to open the shared tab.",
            requireInteraction: true,
          }),
        ]);
        if (epoch !== this.epoch) return;
        const tree = (await this.cdp("Page.getFrameTree")) as {
          frameTree: { frame: { id: string } };
        };
        const world = (await this.cdp("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: `remote-tab-handoff-${wanted.token}`,
        })) as { executionContextId: number };
        if (epoch !== this.epoch) return;
        wanted.context = world.executionContextId;
        this.binding = `remoteTabDone_${wanted.token.replaceAll("-", "")}`;
        await this.cdp("Runtime.addBinding", {
          name: this.binding,
          executionContextId: wanted.context,
        });
        const result = (await this.cdp("Runtime.evaluate", {
          expression: `(${mountHandoff.toString()})(${JSON.stringify(message)},${JSON.stringify(this.binding)},${JSON.stringify(wanted.token)},${Date.parse(expiresAt)})`,
          contextId: wanted.context,
        })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
        this.objectId = result.result?.objectId;
        if (result.exceptionDetails || !this.objectId) throw new Error("Could not display handoff");
        if (epoch !== this.epoch) return;
        this.refresh = setInterval(() => {
          if (epoch === this.epoch)
            void this.call("refresh").catch(() => {
              if (epoch === this.epoch) return this.clear();
            });
        }, 1000);
      })
      .catch(() => {
        // Badge and notification remain available if the document is unsupported.
        if (epoch === this.epoch) this.wanted = undefined;
      });
  }
  async onEvent(method: string, params: Record<string, unknown>) {
    const wanted = this.wanted;
    const epoch = this.epoch;
    if (
      method !== "Runtime.bindingCalled" ||
      !wanted ||
      params.name !== this.binding ||
      params.executionContextId !== wanted.context ||
      params.payload !== wanted.token
    )
      return;
    // Consume before awaiting network delivery. Duplicate/stale events cannot
    // satisfy another handoff; only this isolated context holds the capability.
    this.wanted = undefined;
    try {
      await this.done(wanted.id);
    } catch {
      if (this.epoch === epoch && this.objectId) {
        this.wanted = wanted;
        await this.call("retry").catch(() => {});
      }
    }
  }
  async extend(expiresAt: string) {
    const deadline = Date.parse(expiresAt);
    if (Number.isFinite(deadline)) {
      this.expiresAt = deadline;
      await this.call("refresh").catch(() => {});
    }
  }
  private async call(method: "clear" | "refresh" | "retry") {
    if (!this.objectId) return;
    await this.cdp("Runtime.callFunctionOn", {
      objectId: this.objectId,
      functionDeclaration: `function(){this.${method}(${method === "refresh" ? this.expiresAt : ""})}`,
      returnByValue: true,
    });
  }
  private async remove() {
    clearInterval(this.refresh);
    this.refresh = undefined;
    await this.call("clear").catch(() => {});
    if (this.objectId)
      await this.cdp("Runtime.releaseObject", { objectId: this.objectId }).catch(() => {});
    this.objectId = undefined;
    if (this.binding)
      await this.cdp("Runtime.removeBinding", { name: this.binding }).catch(() => {});
    this.binding = undefined;
    await clearAttentionChrome();
  }
  clear(): Promise<void> {
    ++this.epoch;
    this.wanted = undefined;
    clearInterval(this.refresh);
    this.queue = this.queue.then(() => this.remove()).catch(() => {});
    return this.queue;
  }
}
