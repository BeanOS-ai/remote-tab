import {
  type CreateSessionResponse,
  type RedeemResponse,
  formatCode,
  parseCode,
} from "@remote-tab/protocol";
import { randomSecret } from "@remote-tab/protocol/src/crypto";
import { Peer, baseUrl, jsonPost, object, request } from "./peer";
import {
  type AgentConnectionState,
  type BlobInput,
  type ClientOptions,
  type Command,
  type CommandResult,
  type CreateOptions,
  type Handoff,
  type Hello,
  type RedeemOptions,
  RemoteTabError,
  type ResultBody,
  type WaitOptions,
} from "./types";
export * from "./types";

function validHello(body: unknown): body is Hello {
  return (
    object(body) &&
    ["read", "act", "full"].includes(body.mode as string) &&
    (body.scope === null || typeof body.scope === "string")
  );
}

/** Creates locally held key material. The server receives only TTL and platform authorization. */
export async function createSession(
  options: CreateOptions,
): Promise<{ code: string; session: AgentSession }> {
  const serverUrl = baseUrl(options.serverUrl);
  const secret = randomSecret();
  const response = await request(
    options.fetch ?? ((req) => fetch(req)),
    `${serverUrl}/v1/sessions`,
    options.apiKey,
    jsonPost({ ttl_seconds: options.ttl }),
    options.requestTimeoutMs,
  );
  const created = (await response.json()) as CreateSessionResponse;
  const state: AgentConnectionState = {
    v: 1,
    serverUrl,
    sessionId: created.id,
    secret,
    agentToken: created.agent_token,
  };
  return { code: formatCode(created.id, secret), session: AgentSession.resume(state, options) };
}

export class AgentSession extends Peer {
  private operation: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly connection: AgentConnectionState,
    options: ClientOptions,
  ) {
    super(
      connection.serverUrl,
      connection.sessionId,
      connection.agentToken,
      connection.secret,
      "agent",
      options,
    );
  }
  /** Restores credentials only; readiness and chain are reverified from genesis. */
  static resume(state: AgentConnectionState, options: ClientOptions = {}): AgentSession {
    if (
      state.v !== 1 ||
      !parseCode(formatCode(state.sessionId, state.secret)) ||
      typeof state.agentToken !== "string" ||
      !state.agentToken
    )
      throw new RemoteTabError("invalid", "Invalid private connection state");
    return new AgentSession({ ...state, serverUrl: baseUrl(state.serverUrl) }, options);
  }
  /** Contains secrets: store only in private local state (e.g. a mode-0600 CLI file). */
  exportState(): AgentConnectionState {
    return { ...this.connection };
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn);
    this.operation = result.catch(() => {});
    return result;
  }
  private async suspect(message: string): Promise<never> {
    try {
      await this.call("/stop", { method: "POST" });
    } catch {
      /* Preserve the authentication failure even if the server is unreachable. */
    }
    throw new RemoteTabError("hijack_suspected", message);
  }
  async waitReady(options: WaitOptions = {}): Promise<Hello> {
    const deadline = this.deadline(options);
    let redeemedAt: number | undefined;
    while (true) {
      const remaining = this.checkWait(deadline, options.signal);
      const before = await this.status({ timeoutMs: remaining, signal: options.signal });
      if (before.redeemed && redeemedAt === undefined) redeemedAt = this.options.now();
      const graceRemaining =
        redeemedAt === undefined
          ? remaining
          : this.options.helloGraceMs - (this.options.now() - redeemedAt);
      try {
        await this.refresh(0, this.checkWait(deadline, options.signal), options.signal);
      } catch (error) {
        if (
          error instanceof RemoteTabError &&
          ["decrypt_failed", "protocol_invalid"].includes(error.code) &&
          before.redeemed
        )
          return this.suspect("Redeemer could not authenticate a valid browser hello");
        throw error;
      }
      const hello = this.entries.find((entry) => entry.envelope.kind === "hello");
      if (hello) {
        if (hello.message.seq !== 1 || !validHello(hello.envelope.body))
          return this.suspect("Invalid browser hello");
        this.checkWait(deadline, options.signal);
        this.requireActive(
          await this.status({
            timeoutMs: this.checkWait(deadline, options.signal),
            signal: options.signal,
          }),
        );
        return structuredClone(hello.envelope.body);
      }
      if (this.entries.length > 0) return this.suspect("Browser did not send hello first");
      if (redeemedAt !== undefined && graceRemaining <= 0)
        return this.suspect("Redeemed session did not send an authenticated hello in time");
      if (["stopped", "expired"].includes(before.state)) this.requireActive(before);
      // Created sessions do not long-poll on this server. Sleep to avoid a busy loop.
      if (before.redeemed) {
        try {
          await this.refresh(
            Math.min(this.options.pollWaitSeconds, Math.max(0, graceRemaining) / 1000),
            this.checkWait(deadline, options.signal),
            options.signal,
          );
        } catch (error) {
          if (
            error instanceof RemoteTabError &&
            ["decrypt_failed", "protocol_invalid"].includes(error.code)
          )
            return this.suspect("Redeemer could not authenticate a valid browser hello");
          throw error;
        }
      }
      await this.pause(deadline, options.signal);
    }
  }
  private pendingHandoff(): string | undefined {
    const done = new Set(
      this.entries
        .filter((entry) => entry.envelope.kind === "handoff_done")
        .map((entry) => entry.envelope.id),
    );
    return this.entries.find(
      (entry) => entry.envelope.kind === "handoff" && !done.has(entry.envelope.id),
    )?.envelope.id;
  }
  private async waitEnvelope(id: string, kind: "result" | "handoff_done", options: WaitOptions) {
    const deadline = this.deadline(options);
    while (true) {
      this.checkWait(deadline, options.signal);
      const status = await this.refresh(
        0,
        this.checkWait(deadline, options.signal),
        options.signal,
      );
      const found = this.entries.find(
        (entry) => entry.envelope.kind === kind && entry.envelope.id === id,
      );
      if (found) return found;
      this.requireActive(status);
      await this.refresh(
        this.options.pollWaitSeconds,
        this.checkWait(deadline, options.signal),
        options.signal,
      );
      const arrived = this.entries.find(
        (entry) => entry.envelope.kind === kind && entry.envelope.id === id,
      );
      if (arrived) return arrived;
      await this.pause(deadline, options.signal);
    }
  }
  /** Sends one tool call and returns its correlated result plus all decrypted attachments. */
  send(
    tool: string,
    args: Record<string, unknown> = {},
    options: WaitOptions = {},
  ): Promise<CommandResult> {
    return this.serial(async () => {
      const deadline = this.deadline(options);
      const budget = (): WaitOptions => ({
        timeoutMs: this.checkWait(deadline, options.signal),
        signal: options.signal,
      });
      await this.waitReady(budget());
      if (this.pendingHandoff())
        throw new RemoteTabError("handoff_pending", "Wait for the human to finish the handoff");
      const id = crypto.randomUUID();
      await this.append("command", id, { tool, args }, undefined, budget());
      const entry = await this.waitEnvelope(id, "result", budget());
      const body = entry.envelope.body as ResultBody;
      if (
        typeof body.ok !== "boolean" ||
        (!body.ok &&
          (!object(body.error) ||
            typeof body.error.code !== "string" ||
            typeof body.error.message !== "string"))
      )
        throw new RemoteTabError("protocol_invalid", "Invalid command result");
      return structuredClone({ ...body, id, attachments: await this.attachments(entry, budget()) });
    });
  }
  /** Returns only after the matching human Done message; queued sends stay blocked. */
  handoff(message: string, options: WaitOptions = {}): Promise<void> {
    return this.serial(async () => {
      const deadline = this.deadline(options);
      const budget = (): WaitOptions => ({
        timeoutMs: this.checkWait(deadline, options.signal),
        signal: options.signal,
      });
      await this.waitReady(budget());
      const existing = this.pendingHandoff();
      const id = existing ?? crypto.randomUUID();
      if (!existing) await this.append("handoff", id, { message }, undefined, budget());
      await this.waitEnvelope(id, "handoff_done", budget());
    });
  }
}

/** Shared browser-side crypto/transport. The installed extension owns consent and tool execution. */
export class BrowserPeer extends Peer {
  private delivered = new Set<string>();
  private pending = new Map<string, Command>();
  private handoffId: string | undefined;
  private receiving = false;
  static async redeem(options: RedeemOptions): Promise<BrowserPeer> {
    const parsed = parseCode(options.code);
    if (!parsed || !validHello(options.hello))
      throw new RemoteTabError("invalid", "Invalid code or hello");
    const serverUrl = baseUrl(options.serverUrl);
    const response = await request(
      options.fetch ?? ((req) => fetch(req)),
      `${serverUrl}/v1/sessions/${parsed.sessionId}/redeem`,
      undefined,
      { method: "POST" },
      options.requestTimeoutMs,
    );
    const redeemed = (await response.json()) as RedeemResponse;
    const peer = new BrowserPeer(
      serverUrl,
      parsed.sessionId,
      redeemed.browser_token,
      parsed.secret,
      "browser",
      options,
    );
    await peer.append("hello", crypto.randomUUID(), options.hello);
    return peer;
  }
  /** Single consumer. Handoff is surfaced once; commands remain blocked until handoffDone. */
  async nextCommand(options: WaitOptions = {}): Promise<Command | Handoff> {
    if (this.receiving)
      throw new RemoteTabError("invalid", "Only one nextCommand call may run at a time");
    this.receiving = true;
    const deadline = this.deadline(options);
    try {
      while (true) {
        this.checkWait(deadline, options.signal);
        const status = await this.refresh(
          0,
          this.checkWait(deadline, options.signal),
          options.signal,
        );
        this.requireActive(status);
        if (!this.handoffId) {
          for (const entry of this.entries) {
            const { kind, id, body } = entry.envelope;
            if (this.delivered.has(id) || !["command", "handoff"].includes(kind)) continue;
            if (!object(body))
              throw new RemoteTabError("protocol_invalid", "Invalid browser request");
            if (kind === "handoff") {
              if (typeof body.message !== "string")
                throw new RemoteTabError("protocol_invalid", "Invalid handoff");
              this.handoffId = id;
              this.delivered.add(id);
              return { kind, id, message: body.message };
            }
            if (typeof body.tool !== "string" || !object(body.args))
              throw new RemoteTabError("protocol_invalid", "Invalid command");
            const command: Command = {
              kind: "command",
              id,
              tool: body.tool,
              args: structuredClone(body.args),
            };
            this.delivered.add(id);
            this.pending.set(id, command);
            return command;
          }
        }
        await this.refresh(
          this.options.pollWaitSeconds,
          this.checkWait(deadline, options.signal),
          options.signal,
        );
        await this.pause(deadline, options.signal);
      }
    } finally {
      this.receiving = false;
    }
  }
  async sendResult(
    id: string,
    result: unknown,
    uploads?: { screenshot?: BlobInput; blobs?: BlobInput[] },
  ): Promise<void> {
    if (!this.pending.has(id))
      throw new RemoteTabError("invalid", "Unknown or already answered command");
    await this.append("result", id, { ok: true, result }, uploads);
    this.pending.delete(id);
  }
  async sendError(id: string, code: string, message: string): Promise<void> {
    if (!this.pending.has(id))
      throw new RemoteTabError("invalid", "Unknown or already answered command");
    await this.append("result", id, { ok: false, error: { code, message } });
    this.pending.delete(id);
  }
  async handoffDone(id: string): Promise<void> {
    if (id !== this.handoffId) throw new RemoteTabError("invalid", "Unknown handoff");
    await this.append("handoff_done", id, {});
    this.handoffId = undefined;
  }
  async extend() {
    return (await this.call("/extend", { method: "POST" })).json();
  }
}
