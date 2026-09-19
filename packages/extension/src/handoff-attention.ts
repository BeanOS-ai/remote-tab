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
/** One consented tab's informational attention UI. Revocation is synchronous; rendering and
 * cleanup serialize so a late installation cannot leak into a later handoff. */
export class HandoffAttention {
  private epoch = 0;
  private expiresAt = 0;
  private objectId?: string;
  private queue: Promise<void> = Promise.resolve();
  private refresh?: ReturnType<typeof setInterval>;
  constructor(private readonly cdp: Cdp) {}
  show(message: string, expiresAt: string): void {
    const epoch = ++this.epoch;
    this.expiresAt = Date.parse(expiresAt);
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
          worldName: "remote-tab-handoff",
        })) as { executionContextId: number };
        if (epoch !== this.epoch) return;
        const result = (await this.cdp("Runtime.evaluate", {
          expression: `(${mountHandoff.toString()})(${JSON.stringify(message)},${Date.parse(expiresAt)})`,
          contextId: world.executionContextId,
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
      });
  }
  async extend(expiresAt: string) {
    const deadline = Date.parse(expiresAt);
    if (Number.isFinite(deadline)) {
      this.expiresAt = deadline;
      await this.call("refresh").catch(() => {});
    }
  }
  private async call(method: "clear" | "refresh") {
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
    await clearAttentionChrome();
  }
  clear(): Promise<void> {
    ++this.epoch;
    clearInterval(this.refresh);
    this.queue = this.queue.then(() => this.remove()).catch(() => {});
    return this.queue;
  }
}
