import { BrowserPeer, type ClientOptions, type Hello, RemoteTabError } from "@remote-tab/client";
import { parseCode } from "@remote-tab/protocol";
import { type ControlEvent, MAX_CONTROL_EVENTS, type StopReason } from "./control-events";
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
export type StopObserver = (share: SharedSession, settled: Promise<void>) => void;
/** How long a share keeps retrying while the server answers 429, before it gives up. */
export const THROTTLE_BUDGET_MS = 120_000;
const BUSY_NOTICE = "The server is busy; retrying…";
const throttled = (error: unknown) =>
  error instanceof RemoteTabError && error.code === "rate_limited";
/** Owns one consented tab. The peer/key lives only in memory; restart requires fresh consent. */
export class SharedSession {
  state: ShareState;
  readonly controlEvents: ControlEvent[] = [];
  private lastPauseNotice = "Paused by you";
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  private commandPoll?: AbortController;
  private handoffDelivery?: Promise<void>;
  private stopping?: Promise<void>;
  private started = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private pauseEpoch = 0;
  private actionEpoch?: number;
  get interrupted() {
    return (
      this.state.paused || (this.actionEpoch !== undefined && this.actionEpoch !== this.pauseEpoch)
    );
  }
  private constructor(
    readonly peer: BrowserPeer,
    readonly driver: TabDriver,
    readonly detach: () => Promise<void>,
    hello: Hello,
    private readonly onStop?: StopObserver,
    private readonly onHandoff?: (
      handoff: ShareState["handoff"],
      expiresAt: string,
    ) => void | Promise<void>,
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
      onStop?: StopObserver;
      onHandoff?: (handoff: ShareState["handoff"], expiresAt: string) => void | Promise<void>;
    },
  ) {
    if (!parseCode(options.code)) throw new Error("Paste a valid rt1. code from your agent");
    const peer = await BrowserPeer.redeem(options);
    const share = new SharedSession(
      peer,
      options.driver,
      options.detach,
      options.hello,
      options.onStop,
      options.onHandoff,
    );
    try {
      share.state.expiresAt = (await peer.status()).expires_at;
      if (options.isCancelled?.()) throw new Error("Sharing cancelled");
      share.armExpiry();
      share.started = true;
      share.loop = share.run();
      return share;
    } catch (error) {
      await share.stop("connection_lost");
      throw error;
    }
  }
  private armExpiry() {
    clearTimeout(this.expiryTimer);
    const remaining = Date.parse(this.state.expiresAt ?? "") - Date.now();
    if (!Number.isFinite(remaining)) throw new Error("Invalid expiry");
    this.expiryTimer = setTimeout(
      () => {
        void this.stop("expired");
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
          command = await this.withThrottleRetry(() =>
            this.peer.nextCommand({
              signal: AbortSignal.any([this.abort.signal, poll.signal]),
              timeoutMs: 30_000,
            }),
          );
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
          this.onHandoff?.(this.state.handoff, this.state.expiresAt ?? "");
          this.state.paused = true;
          this.driver.setPaused(true);
          this.log("Your agent needs you. Click Done when finished.");
          continue;
        }
        if (command.tool === "remote_tab_status") {
          const lastSeq = (await this.withThrottleRetry(() => this.peer.status())).last_seq;
          await this.withThrottleRetry(() =>
            this.peer.sendResult(command.id, {
              mode: this.state.mode,
              scope: this.state.scope,
              expiresAt: this.state.expiresAt,
              paused: this.state.paused,
              last_seq: lastSeq,
            }),
          );
          continue;
        }
        if (command.tool === "remote_tab_stop") {
          await this.stop("agent");
          break;
        }
        if (this.state.paused) {
          await this.withThrottleRetry(() =>
            this.peer.sendError(
              command.id,
              "paused",
              `${this.pauseNotice}. Click Resume to continue.`,
            ),
          );
          continue;
        }
        let output: Awaited<ReturnType<TabDriver["execute"]>>;
        const actionEpoch = this.pauseEpoch;
        this.actionEpoch = actionEpoch;
        try {
          output = await this.driver.execute(command.tool, command.args);
        } catch (error) {
          if (this.abort.signal.aborted) break;
          const interrupted = this.state.paused || actionEpoch !== this.pauseEpoch;
          const code = interrupted
            ? "paused"
            : error instanceof DriverError
              ? error.code
              : "command_failed";
          const message = interrupted
            ? this.pauseNotice
            : error instanceof DriverError
              ? error.message
              : "The tab command failed";
          this.state.notice = message;
          this.log(message);
          await this.withThrottleRetry(() => this.peer.sendError(command.id, code, message));
          continue;
        } finally {
          this.actionEpoch = undefined;
        }
        if (this.abort.signal.aborted) break;
        if (this.state.paused || actionEpoch !== this.pauseEpoch) {
          await this.withThrottleRetry(() =>
            this.peer.sendError(command.id, "paused", this.pauseNotice),
          );
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
        await this.withThrottleRetry(() =>
          this.peer.sendResult(command.id, result, {
            blobs,
            ...(output.screenshot
              ? { screenshot: { bytes: new Uint8Array(output.screenshot), mimeType: "image/png" } }
              : {}),
          }),
        );
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        const ended = error instanceof RemoteTabError && error.code === "session_not_active";
        this.state.notice = ended
          ? "Sharing ended or expired"
          : "Connection ended. Start a new share to continue.";
        await this.stop(ended ? "remote_ended" : "connection_lost");
      }
    }
  }
  /**
   * A 429 means the server did not apply the request (appends retry their own
   * committed echo reads), so retrying is safe. A throttled share keeps its
   * consent instead of ending; it gives up only after THROTTLE_BUDGET_MS.
   */
  private async withThrottleRetry<T>(operation: () => Promise<T>): Promise<T> {
    const giveUpAt = Date.now() + THROTTLE_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await operation();
        if (this.state.notice === BUSY_NOTICE) this.state.notice = undefined;
        return value;
      } catch (error) {
        const delay = Math.min(10_000, 1000 * 2 ** attempt);
        if (!throttled(error) || this.abort.signal.aborted || Date.now() + delay > giveUpAt)
          throw error;
        this.state.notice = BUSY_NOTICE;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, delay);
          this.abort.signal.addEventListener("abort", done, { once: true });
        });
        if (this.abort.signal.aborted) throw error;
      }
    }
  }
  private log(message: string) {
    this.state.actions.push(message);
    if (this.state.actions.length > 50) this.state.actions.shift();
  }
  private recordControl(action: "pause" | "resume") {
    this.pushControl({ action, timestamp: new Date().toISOString() });
  }
  private pushControl(event: ControlEvent) {
    this.controlEvents.push(event);
    if (this.controlEvents.length > MAX_CONTROL_EVENTS) this.controlEvents.shift();
  }
  private get pauseNotice(): string {
    return this.lastPauseNotice;
  }
  pause() {
    if (!this.state.sharing) return;
    this.onHandoff?.(undefined, this.state.expiresAt ?? "");
    this.pauseEpoch++;
    this.driver.setPaused(true);
    this.state.paused = true;
    this.recordControl("pause");
    this.lastPauseNotice = `Paused by you at ${new Date().toISOString().slice(11, 19)} UTC`;
    this.state.notice = this.lastPauseNotice;
    this.log(this.state.notice);
  }
  resume() {
    if (!this.state.sharing) throw new Error("Sharing has ended");
    if (this.state.handoff) throw new Error("Click Done to finish your agent’s handoff");
    if (!this.state.paused) return;
    this.state.paused = false;
    this.driver.setPaused(false);
    this.state.notice = undefined;
    this.recordControl("resume");
    this.log(`Resumed sharing at ${new Date().toISOString().slice(11, 19)} UTC`);
  }
  async done() {
    const handoff = this.state.handoff;
    if (!this.state.sharing || !handoff) throw new Error("No handoff is waiting");
    if (this.handoffDelivery) return this.handoffDelivery;
    const epoch = this.pauseEpoch;
    this.commandPoll?.abort();
    const delivery = (async () => {
      await this.peer.handoffDone(handoff.id);
      if (!this.state.sharing) return;
      this.state.handoff = undefined;
      // Keep the command loop blocked until attention UI has been removed, so
      // the next snapshot/action cannot see or hit extension controls.
      await this.onHandoff?.(undefined, this.state.expiresAt ?? "");
      if (!this.state.sharing || epoch !== this.pauseEpoch) return;
      this.state.paused = false;
      this.driver.setPaused(false);
      this.state.notice = undefined;
      this.log("Handoff complete; agent resumed");
    })();
    this.handoffDelivery = delivery;
    try {
      await delivery;
    } finally {
      if (this.handoffDelivery === delivery) this.handoffDelivery = undefined;
    }
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
  /** Ends the share once; the first caller's reason is what the history records. */
  stop(reason: StopReason): Promise<void> {
    if (this.stopping) return this.stopping;
    this.pushControl({ action: "stop", reason, timestamp: new Date().toISOString() });
    this.state.sharing = false;
    this.state.handoff = undefined;
    this.onHandoff?.(undefined, this.state.expiresAt ?? "");
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
    try {
      if (this.started) this.onStop?.(this, this.stopping);
    } catch {
      this.state.notice =
        "Sharing stopped. Open the interaction summary from the popup to save your history.";
    }
    return this.stopping;
  }
  async settled() {
    await this.loop;
  }
}
