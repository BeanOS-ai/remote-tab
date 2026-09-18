import { BrowserPeer, type ClientOptions, type Hello, RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { DriverError, type TabDriver } from "./driver";
import { actionSummary } from "./summary";

export interface ShareState {
  sharing: boolean;
  paused: boolean;
  handoff?: { id: string; message: string };
  actions: string[];
  extended: boolean;
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
  private commandPoll?: AbortController;
  private handoffDelivery?: Promise<void>;
  private stopping?: Promise<void>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private takeoverEpoch = 0;
  private actionEpoch?: number;
  get interrupted() {
    return (
      this.state.paused ||
      (this.actionEpoch !== undefined && this.actionEpoch !== this.takeoverEpoch)
    );
  }
  private constructor(
    readonly peer: BrowserPeer,
    readonly driver: TabDriver,
    readonly detach: () => Promise<void>,
    hello: Hello,
  ) {
    this.state = {
      sharing: true,
      paused: false,
      actions: [],
      extended: false,
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
      isCancelled?: () => boolean;
      isPaused?: () => boolean;
    },
  ) {
    if (!parseCode(options.code)) throw new Error("Paste a valid rt1. code from your agent");
    const peer = await BrowserPeer.redeem(options);
    const share = new SharedSession(peer, options.driver, options.detach, options.hello);
    try {
      share.state.expiresAt = (await peer.status()).expires_at;
      if (options.isCancelled?.()) throw new Error("Sharing cancelled");
      share.state.paused = options.isPaused?.() ?? false;
      share.driver.setPaused(share.state.paused);
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
        // A human Done interrupts the idle read, then gets the peer write lock.
        await this.handoffDelivery;
        if (this.abort.signal.aborted) break;
        const poll = new AbortController();
        this.commandPoll = poll;
        let command: Awaited<ReturnType<BrowserPeer["nextCommand"]>>;
        try {
          command = await this.peer.nextCommand({
            signal: AbortSignal.any([this.abort.signal, poll.signal]),
            timeoutMs: 30_000,
          });
        } catch (error) {
          if (poll.signal.aborted && !this.abort.signal.aborted) continue;
          if (error instanceof RemoteTabError && error.code === "timeout") continue;
          throw error;
        } finally {
          if (this.commandPoll === poll) this.commandPoll = undefined;
        }
        if (this.abort.signal.aborted) break;
        if (command.kind === "handoff") {
          this.state.handoff = { id: command.id, message: command.message };
          this.state.paused = true;
          this.driver.setPaused(true);
          this.log("Your agent needs you. Click Done when finished.");
          continue;
        }
        if (command.tool === "remote_tab_status") {
          await this.peer.sendResult(command.id, {
            mode: this.state.mode,
            scope: this.state.scope,
            expiresAt: this.state.expiresAt,
            paused: this.state.paused,
            last_seq: (await this.peer.status()).last_seq,
          });
          continue;
        }
        if (command.tool === "remote_tab_stop") {
          await this.stop();
          break;
        }
        if (this.state.paused) {
          await this.peer.sendError(
            command.id,
            "paused",
            "Paused: you took over. Click Resume to continue.",
          );
          continue;
        }
        let output: Awaited<ReturnType<TabDriver["execute"]>>;
        const actionEpoch = this.takeoverEpoch;
        this.actionEpoch = actionEpoch;
        try {
          output = await this.driver.execute(command.tool, command.args);
        } catch (error) {
          if (this.abort.signal.aborted) break;
          const interrupted = this.state.paused || actionEpoch !== this.takeoverEpoch;
          const code = interrupted
            ? "paused"
            : error instanceof DriverError
              ? error.code
              : "command_failed";
          const message = interrupted
            ? "Paused: you took over"
            : error instanceof DriverError
              ? error.message
              : "The tab command failed";
          this.state.notice = message;
          this.log(message);
          await this.peer.sendError(command.id, code, message);
          continue;
        } finally {
          this.actionEpoch = undefined;
        }
        if (this.abort.signal.aborted) break;
        if (this.state.paused || actionEpoch !== this.takeoverEpoch) {
          await this.peer.sendError(command.id, "paused", "Paused: you took over");
          continue;
        }
        this.log(actionSummary(command.tool));
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
  private log(message: string) {
    this.state.actions.push(message);
    if (this.state.actions.length > 50) this.state.actions.shift();
  }
  pause() {
    if (!this.state.sharing) return;
    this.takeoverEpoch++;
    this.driver.setPaused(true);
    if (this.state.paused) return;
    this.state.paused = true;
    this.state.notice = "Paused: you took over";
    this.log("Paused: you took over");
  }
  resume() {
    if (!this.state.sharing) throw new Error("Sharing has ended");
    if (this.state.handoff) throw new Error("Click Done to finish your agent’s handoff");
    this.state.paused = false;
    this.driver.setPaused(false);
    this.state.notice = undefined;
    this.log("Resumed sharing");
  }
  async done() {
    const handoff = this.state.handoff;
    if (!this.state.sharing || !handoff) throw new Error("No handoff is waiting");
    if (this.handoffDelivery) return this.handoffDelivery;
    const epoch = this.takeoverEpoch;
    this.commandPoll?.abort();
    const delivery = this.peer.handoffDone(handoff.id);
    this.handoffDelivery = delivery;
    try {
      await delivery;
    } finally {
      if (this.handoffDelivery === delivery) this.handoffDelivery = undefined;
    }
    if (!this.state.sharing) return;
    this.state.handoff = undefined;
    if (epoch !== this.takeoverEpoch) {
      this.state.notice = "Paused: you took over";
      return;
    }
    this.state.paused = false;
    this.driver.setPaused(false);
    this.state.notice = undefined;
    this.log("Handoff complete; agent resumed");
  }
  async extend() {
    if (!this.state.sharing) throw new Error("Sharing has ended");
    const status = await this.peer.extend();
    if (!this.state.sharing) return;
    if (
      !status ||
      typeof status.expires_at !== "string" ||
      !Number.isFinite(Date.parse(status.expires_at))
    )
      throw new Error("Invalid expiry response");
    this.state.expiresAt = status.expires_at;
    this.state.extended = true;
    this.armExpiry();
    this.log("Extended sharing by 30 minutes");
    return status;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state.sharing = false;
    this.log("Sharing stopped");
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
