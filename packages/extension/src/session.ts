import { BrowserPeer, type ClientOptions, type Hello, RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { DriverError, type TabDriver } from "./driver";

export interface ShareState {
  sharing: boolean;
  sessionId?: string;
  mode?: string;
  scope?: string | null;
  url?: string;
  title?: string;
  expiresAt?: string;
  notice?: string;
}
/** Owns one consented tab. The peer/key lives only in memory; restart requires fresh consent. */
export class SharedSession {
  state: ShareState;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  private stopping?: Promise<void>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private constructor(
    readonly peer: BrowserPeer,
    readonly driver: TabDriver,
    readonly detach: () => Promise<void>,
    hello: Hello,
  ) {
    this.state = {
      sharing: true,
      sessionId: peer.sessionId,
      mode: hello.mode,
      scope: hello.scope,
      url: hello.url,
      title: hello.title,
    };
  }
  static async connect(
    options: ClientOptions & {
      code: string;
      serverUrl: string;
      hello: Hello;
      driver: TabDriver;
      detach: () => Promise<void>;
    },
  ) {
    if (!parseCode(options.code)) throw new Error("Paste a valid rt1. code from your agent");
    const peer = await BrowserPeer.redeem(options);
    const share = new SharedSession(peer, options.driver, options.detach, options.hello);
    try {
      share.state.expiresAt = (await peer.status()).expires_at;
      share.armExpiry();
      share.loop = share.run();
      return share;
    } catch (error) {
      await share.stop();
      throw error;
    }
  }
  private armExpiry() {
    clearTimeout(this.expiryTimer);
    const remaining = Date.parse(this.state.expiresAt ?? "") - Date.now();
    if (!Number.isFinite(remaining)) throw new Error("Invalid expiry");
    this.expiryTimer = setTimeout(
      () => {
        void this.stop();
      },
      Math.max(0, remaining),
    );
  }
  private async run() {
    try {
      while (!this.abort.signal.aborted) {
        let command: Awaited<ReturnType<BrowserPeer["nextCommand"]>>;
        try {
          command = await this.peer.nextCommand({ signal: this.abort.signal, timeoutMs: 30_000 });
        } catch (error) {
          if (error instanceof RemoteTabError && error.code === "timeout") continue;
          throw error;
        }
        if (this.abort.signal.aborted) break;
        if (command.kind === "handoff") {
          this.state.notice = "Your agent requested a handoff. Stop sharing to take over.";
          continue;
        }
        if (command.tool === "remote_tab_status") {
          await this.peer.sendResult(command.id, this.state);
          continue;
        }
        if (command.tool === "remote_tab_stop") {
          await this.stop();
          break;
        }
        let output: Awaited<ReturnType<TabDriver["execute"]>>;
        try {
          output = await this.driver.execute(command.tool, command.args);
        } catch (error) {
          if (this.abort.signal.aborted) break;
          const code = error instanceof DriverError ? error.code : "command_failed";
          const message = error instanceof DriverError ? error.message : "The tab command failed";
          this.state.notice = message;
          await this.peer.sendError(command.id, code, message);
          continue;
        }
        if (this.abort.signal.aborted) break;
        // Large snapshots/results travel as encrypted blobs, under the 64KiB message ceiling.
        const serialized = new TextEncoder().encode(JSON.stringify(output.result));
        const blobs = (output.blobs ?? []).map((blob) => ({
          ...blob,
          bytes: new Uint8Array(blob.bytes),
        }));
        const result =
          serialized.byteLength > 24 * 1024
            ? {
                format: "application/json",
                attachment: blobs.push({ bytes: serialized, mimeType: "application/json" }) - 1,
              }
            : output.result;
        await this.peer.sendResult(command.id, result, {
          blobs,
          ...(output.screenshot
            ? { screenshot: { bytes: new Uint8Array(output.screenshot), mimeType: "image/png" } }
            : {}),
        });
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.state.notice =
          error instanceof RemoteTabError && error.code === "session_not_active"
            ? "Sharing ended or expired"
            : "Connection ended. Start a new share to continue.";
        await this.stop();
      }
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state.sharing = false;
    this.abort.abort();
    clearTimeout(this.expiryTimer);
    // Detach first; network failure must never leave local control attached.
    this.stopping = (async () => {
      try {
        await this.detach();
      } catch {
        /* Already detached or tab closed. */
      }
      try {
        await this.peer.stop();
      } catch {
        this.state.notice = "Stopped locally; server unavailable or session expired.";
      }
    })();
    return this.stopping;
  }
  async settled() {
    await this.loop;
  }
}
