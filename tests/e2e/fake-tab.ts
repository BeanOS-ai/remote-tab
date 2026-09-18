import { BrowserPeer, type Command, type RedeemOptions, RemoteTabError } from "@remote-tab/client";

// A real, valid 1x1 PNG fixture. This harness models a tab, not extension execution/security policy.
export const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
export const HELLO = {
  mode: "act" as const,
  scope: "https://example.test",
  title: "Fake form",
  url: "https://example.test/form",
};

/** Stable element refs and form state driven through the real browser crypto/transport peer. */
export class FakeTab {
  readonly executed: Command[] = [];
  value = "";
  submitted = "";
  handoffMessage?: string;
  terminal?: string;
  private readonly controller = new AbortController();
  private handoffId?: string;
  private failure?: unknown;
  private readonly worker: Promise<void>;

  private constructor(readonly peer: BrowserPeer) {
    this.worker = this.run().catch((error) => {
      this.failure = error;
    });
  }
  static async redeem(options: Omit<RedeemOptions, "hello">): Promise<FakeTab> {
    return new FakeTab(await BrowserPeer.redeem({ ...options, hello: HELLO }));
  }
  snapshot() {
    return {
      url: HELLO.url,
      title: HELLO.title,
      nodes: [
        { ref: "name", role: "textbox", name: "Name", value: this.value },
        { ref: "submit", role: "button", name: "Submit" },
        { ref: "result", role: "status", text: this.submitted },
      ],
    };
  }
  async done() {
    if (!this.handoffId) throw new Error("No human handoff pending");
    await this.peer.handoffDone(this.handoffId);
    this.handoffId = undefined;
    this.handoffMessage = undefined;
  }
  async close() {
    this.controller.abort();
    await this.worker;
    if (this.failure) throw this.failure;
  }
  private async run() {
    while (!this.controller.signal.aborted) {
      try {
        const request = await this.peer.nextCommand({
          timeoutMs: 100,
          signal: this.controller.signal,
        });
        if (request.kind === "handoff") {
          this.handoffId = request.id;
          this.handoffMessage = request.message;
          continue;
        }
        this.executed.push(request);
        const { tool, args, id } = request;
        let result: unknown;
        let shot = false;
        if (tool === "browser_snapshot") result = this.snapshot();
        else if (tool === "browser_type" && args.ref === "name" && typeof args.text === "string") {
          this.value = args.text;
          result = { typed: this.value };
          shot = true;
        } else if (tool === "browser_click" && args.ref === "submit") {
          this.submitted = `Submitted: ${this.value}`;
          result = { submitted: this.submitted };
          shot = true;
        } else if (tool === "browser_take_screenshot") {
          result = { captured: true };
          shot = true;
        } else {
          await this.peer.sendError(id, "invalid", "Unsupported fake-tab command or ref");
          continue;
        }
        await this.peer.sendResult(
          id,
          result,
          shot ? { screenshot: { bytes: PNG, mimeType: "image/png" } } : undefined,
        );
      } catch (error) {
        if (error instanceof RemoteTabError) {
          if (error.code === "timeout") continue;
          if (error.code === "aborted" && this.controller.signal.aborted) return;
          if (error.code === "session_not_active") {
            this.terminal = (await this.peer.status()).state;
            return;
          }
        }
        throw error;
      }
    }
  }
}

/** Bounded observation of the fake human/browser; never leaves a polling timer behind. */
export async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fake tab");
    await Bun.sleep(5);
  }
}
