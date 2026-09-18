import {
  type Envelope,
  LIMITS,
  type Role,
  type SessionStatus,
  type WireMessage,
} from "@remote-tab/protocol";
import {
  b64url,
  chainHash,
  deriveSessionKey,
  messageAad,
  open,
  openBytes,
  seal,
  sealBytes,
  unb64url,
  verifyChain,
} from "@remote-tab/protocol/src/crypto";
import {
  type Attachment,
  type BlobInput,
  type BlobReference,
  type ClientOptions,
  type Fetch,
  type Ledger,
  type LedgerEntry,
  RemoteTabError,
  type WaitOptions,
} from "./types";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function baseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RemoteTabError(
      "invalid",
      "serverUrl must be an HTTP(S) origin or base path without credentials, query, or fragment",
    );
  return url.href.replace(/\/$/, "");
}
export async function request(
  fetcher: Fetch,
  url: string,
  token: string | undefined,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  if (init.signal?.aborted) throw new RemoteTabError("aborted", "Operation aborted");
  try {
    const response = await Promise.race([
      (async () => {
        const response = await fetcher(
          new Request(url, {
            ...init,
            redirect: "error",
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(init.headers ?? {}),
            },
            signal: controller.signal,
          }),
        );
        const bytes = await response.arrayBuffer();
        return new Response(bytes.byteLength ? bytes : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })(),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new RemoteTabError("aborted", "Operation aborted"));
        };
        init.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new RemoteTabError("timeout", "HTTP request timed out"));
        }, timeoutMs);
      }),
    ]);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new RemoteTabError(
        body.error ?? "invalid",
        body.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
    if (onAbort) init.signal?.removeEventListener("abort", onAbort);
  }
}
export const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Shared authenticated transport. No browser framework or Node APIs. */
export class Peer {
  protected entries: LedgerEntry[] = [];
  protected readonly key: Promise<CryptoKey>;
  protected readonly fetcher: Fetch;
  protected readonly options: Required<Omit<ClientOptions, "fetch">>;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  constructor(
    readonly serverUrl: string,
    readonly sessionId: string,
    private readonly token: string,
    secret: string | Promise<CryptoKey>,
    readonly role: Role,
    options: ClientOptions,
  ) {
    this.key = typeof secret === "string" ? deriveSessionKey(secret, sessionId) : secret;
    this.fetcher = options.fetch ?? ((req) => fetch(req));
    this.options = {
      timeoutMs: 120_000,
      helloGraceMs: 10_000,
      pollWaitSeconds: 25,
      pollIntervalMs: 100,
      requestTimeoutMs: 30_000,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
    for (const field of [
      "timeoutMs",
      "helloGraceMs",
      "pollIntervalMs",
      "requestTimeoutMs",
      "pollWaitSeconds",
    ] as const) {
      if (!Number.isFinite(this.options[field]) || this.options[field] < 0)
        throw new RemoteTabError("invalid", `${field} must be nonnegative and finite`);
    }
    this.options.pollWaitSeconds = Math.min(
      this.options.pollWaitSeconds,
      LIMITS.longPollMaxSeconds,
    );
  }
  protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    const pending = this.queue.then(fn).finally(() => {
      this.busy--;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  protected async call(
    path = "",
    init: RequestInit = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<Response> {
    return request(
      this.fetcher,
      `${this.serverUrl}/v1/sessions/${this.sessionId}${path}`,
      this.token,
      init,
      timeoutMs,
    );
  }
  async status(options: WaitOptions = {}): Promise<SessionStatus> {
    const status = (await (
      await this.call("", { signal: options.signal }, options.timeoutMs)
    ).json()) as SessionStatus;
    if (
      status.id !== this.sessionId ||
      !Number.isSafeInteger(status.last_seq) ||
      status.last_seq < 0 ||
      typeof status.last_hash !== "string" ||
      !["created", "redeemed", "active", "stopped", "expired"].includes(status.state)
    )
      throw new RemoteTabError("protocol_invalid", "Invalid session status");
    return status;
  }
  protected tail(): { seq: number; hash: string } {
    return this.entries.at(-1)?.message ?? { seq: 0, hash: "" };
  }
  protected async accept(messages: WireMessage[]): Promise<void> {
    if (!Array.isArray(messages))
      throw new RemoteTabError("protocol_invalid", "Invalid message page");
    for (const message of messages) {
      const tail = this.tail();
      if (
        message.seq !== tail.seq + 1 ||
        message.prev_hash !== tail.hash ||
        !["agent", "browser"].includes(message.role) ||
        message.hash !== (await chainHash(this.sessionId, message.seq, message.ciphertext))
      )
        throw new RemoteTabError("chain_invalid", "Message chain is broken");
      let envelope: Envelope;
      try {
        envelope = await open(
          await this.key,
          message,
          messageAad(this.sessionId, message.role, message.prev_hash),
        );
      } catch {
        throw new RemoteTabError("decrypt_failed", "Message authentication failed");
      }
      const allowed =
        message.role === "agent"
          ? ["command", "handoff", "stop"]
          : ["hello", "result", "handoff_done", "stop"];
      if (
        !allowed.includes(envelope.kind) ||
        typeof envelope.id !== "string" ||
        !envelope.id ||
        !object(envelope.body)
      )
        throw new RemoteTabError("protocol_invalid", "Invalid envelope");
      this.entries.push({ message, envelope, attachments: [] });
    }
  }
  /** Anchors every read to status; the server may append newer messages while paging. */
  protected async refresh(
    waitSeconds = 0,
    budgetMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<SessionStatus> {
    const deadline = this.options.now() + budgetMs;
    return this.exclusive(async () =>
      this.refreshUnlocked(waitSeconds, this.checkWait(deadline, signal), signal),
    );
  }
  private async refreshUnlocked(
    waitSeconds = 0,
    budgetMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<SessionStatus> {
    const deadline = this.options.now() + budgetMs;
    const anchor = await this.status({ timeoutMs: budgetMs, signal });
    let wait = waitSeconds;
    if (anchor.last_seq < this.tail().seq)
      throw new RemoteTabError("chain_invalid", "Server rolled back the chain");
    do {
      const before = this.tail().seq;
      const page = (await (
        await this.call(
          `/messages?after=${before}&wait=${Math.min(wait, Math.max(0, this.checkWait(deadline, signal) - 5) / 1000)}`,
          { signal },
          Math.min(this.options.requestTimeoutMs, this.checkWait(deadline, signal)),
        )
      ).json()) as { messages: WireMessage[]; state: SessionStatus["state"] };
      await this.accept(page.messages);
      // A stop/expiry observed by this read supersedes the earlier status snapshot.
      if (page.state === "stopped" || page.state === "expired") anchor.state = page.state;
      if (this.tail().seq < anchor.last_seq && before === this.tail().seq)
        throw new RemoteTabError("chain_invalid", "Server truncated the chain");
      wait = 0;
    } while (this.tail().seq < anchor.last_seq);
    const hash = anchor.last_seq === 0 ? "" : this.entries[anchor.last_seq - 1]?.message.hash;
    if (hash !== anchor.last_hash)
      throw new RemoteTabError("chain_invalid", "Status chain hash does not match messages");
    return anchor;
  }
  protected async append(
    kind: Envelope["kind"],
    id: string,
    body: unknown,
    uploads?: { screenshot?: BlobInput; blobs?: BlobInput[] },
    options: WaitOptions = {},
  ): Promise<void> {
    const deadline = this.deadline(options);
    const call = (path: string, init: RequestInit) =>
      this.call(
        path,
        { ...init, signal: options.signal },
        Math.min(this.options.requestTimeoutMs, this.checkWait(deadline, options.signal)),
      );
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = await this.refreshUnlocked(
          0,
          this.checkWait(deadline, options.signal),
          options.signal,
        );
        this.requireActive(status);
        const prev = this.tail().hash;
        const aad = messageAad(this.sessionId, this.role, prev);
        const upload = async (input: BlobInput): Promise<BlobReference> => {
          if (input.bytes.byteLength + 16 > LIMITS.blobMaxBytes)
            throw new RemoteTabError("too_large", "Encrypted blob exceeds 4 MiB");
          const sealed = await sealBytes(await this.key, input.bytes, aad);
          const { blob_id } = await (
            await call("/blobs", {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: sealed.ciphertext,
            })
          ).json();
          return {
            blob_id,
            nonce: b64url(sealed.nonce),
            role: this.role,
            prev_hash: prev,
            mime_type: input.mimeType,
          };
        };
        const envelope: Envelope = { v: 1, kind, id, body: structuredClone(body) };
        if (uploads && object(envelope.body)) {
          if (uploads.screenshot) envelope.body.screenshot = await upload(uploads.screenshot);
          if (uploads.blobs) envelope.body.blobs = await Promise.all(uploads.blobs.map(upload));
        }
        const sealed = await seal(await this.key, envelope, aad);
        const post = jsonPost({ role: this.role, prev_hash: prev, ...sealed });
        if (new TextEncoder().encode(post.body as string).byteLength > LIMITS.messageMaxBytes)
          throw new RemoteTabError("too_large", "Encrypted message exceeds 64 KiB; use a blob");
        try {
          const result = (await (await call("/messages", post)).json()) as {
            seq: number;
            hash: string;
          };
          if (
            result.seq !== this.tail().seq + 1 ||
            result.hash !== (await chainHash(this.sessionId, result.seq, sealed.ciphertext))
          )
            throw new RemoteTabError("chain_invalid", "Invalid append acknowledgement");
          // Read the committed echo before trusting it or allowing later actions.
          await this.refreshUnlocked(0, this.checkWait(deadline, options.signal), options.signal);
          const echo = this.entries[result.seq - 1];
          if (echo?.message.hash !== result.hash)
            throw new RemoteTabError(
              "chain_invalid",
              "Append acknowledgement is absent from chain",
            );
          return;
        } catch (error) {
          if (
            !(error instanceof RemoteTabError) ||
            error.code !== "chain_mismatch" ||
            attempt === 1
          )
            throw error;
          // Refresh, reseal all bytes with fresh nonces/AAD, and retry exactly once.
        }
      }
    });
  }
  protected requireActive(status: SessionStatus): void {
    if (status.state !== "active")
      throw new RemoteTabError("session_not_active", `Session is ${status.state}`);
  }
  protected deadline(options: WaitOptions): number {
    return this.options.now() + (options.timeoutMs ?? this.options.timeoutMs);
  }
  protected checkWait(deadline: number, signal?: AbortSignal): number {
    if (signal?.aborted) throw new RemoteTabError("aborted", "Operation aborted");
    const remaining = deadline - this.options.now();
    if (remaining <= 0) throw new RemoteTabError("timeout", "Timed out waiting for peer");
    return remaining;
  }
  protected async pause(deadline: number, signal?: AbortSignal): Promise<void> {
    const ms = Math.min(this.options.pollIntervalMs, this.checkWait(deadline, signal));
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        this.options.sleep(ms),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new RemoteTabError("aborted", "Operation aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  protected async attachments(
    entry: LedgerEntry,
    options: WaitOptions = {},
  ): Promise<Attachment[]> {
    const deadline = this.deadline(options);
    const found: BlobReference[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!object(value)) return;
      if ("blob_id" in value) {
        if (
          typeof value.blob_id !== "string" ||
          !/^[A-Za-z0-9_-]{16,64}$/.test(value.blob_id) ||
          typeof value.nonce !== "string" ||
          !/^[A-Za-z0-9_-]{16}$/.test(value.nonce) ||
          value.role !== entry.message.role ||
          value.prev_hash !== entry.message.prev_hash ||
          typeof value.mime_type !== "string"
        )
          throw new RemoteTabError("protocol_invalid", "Invalid blob reference");
        found.push(value as unknown as BlobReference);
      } else for (const child of Object.values(value)) visit(child);
    };
    visit(entry.envelope.body);
    return Promise.all(
      found.map(async (reference) => {
        const bytes = new Uint8Array(
          await (
            await this.call(
              `/blobs/${reference.blob_id}`,
              { signal: options.signal },
              Math.min(this.options.requestTimeoutMs, this.checkWait(deadline, options.signal)),
            )
          ).arrayBuffer(),
        );
        try {
          return {
            reference,
            bytes: await openBytes(
              await this.key,
              unb64url(reference.nonce),
              bytes,
              messageAad(this.sessionId, reference.role, reference.prev_hash),
            ),
          };
        } catch {
          throw new RemoteTabError("decrypt_failed", "Blob authentication failed");
        }
      }),
    );
  }
  /** Verify from genesis again, then decrypt every referenced blob, including after stop/expiry. */
  async ledger(): Promise<Ledger> {
    const known = this.tail();
    const reader = new Peer(this.serverUrl, this.sessionId, this.token, this.key, this.role, {
      ...this.options,
      fetch: this.fetcher,
    });
    const status = await reader.refresh();
    if (
      known.seq > status.last_seq ||
      (known.seq > 0 && reader.entries[known.seq - 1]?.message.hash !== known.hash)
    )
      throw new RemoteTabError("chain_invalid", "Ledger rolled back a previously verified chain");
    // The captured status is a consistent ledger snapshot even if the GET saw newer messages.
    reader.entries = reader.entries.slice(0, status.last_seq);
    const verified = await verifyChain(
      this.sessionId,
      reader.entries.map(({ message }) => ({ ...message, prevHash: message.prev_hash })),
    );
    if (!verified.ok) throw new RemoteTabError("chain_invalid", verified.reason);
    const entries = await Promise.all(
      reader.entries.map(async (entry) => ({
        ...entry,
        attachments: await reader.attachments(entry),
      })),
    );
    return structuredClone({ sessionId: this.sessionId, status, entries });
  }
  /** Terminal stop takes priority over the best-effort audit envelope and pending long-polls. */
  async stop(reason = "stopped"): Promise<SessionStatus> {
    try {
      if ((await this.status()).state === "active" && this.busy === 0)
        await this.append("stop", crypto.randomUUID(), { reason });
    } finally {
      await this.call("/stop", { method: "POST" });
    }
    return this.status();
  }
}
