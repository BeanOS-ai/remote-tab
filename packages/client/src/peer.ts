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
  type LedgerOptions,
  RemoteTabError,
  type WaitOptions,
} from "./types";

interface LedgerBudget {
  maxEntries: number;
  maxBytes: number;
  usedBytes: number;
}
const ledgerTooLarge = () =>
  new RemoteTabError("ledger_too_large", "Ledger exceeds retrieval limits");
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function charge(budget: LedgerBudget | undefined, bytes: number): void {
  if (!budget) return;
  if (bytes > budget.maxBytes - budget.usedBytes) throw ledgerTooLarge();
  budget.usedBytes += bytes;
}

/** Enforce the limit while consuming the body, including servers without Content-Length. */
async function limitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBytes) throw ledgerTooLarge();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      if (signal.aborted) throw new RemoteTabError("aborted", "Operation aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - total) throw ledgerTooLarge();
      total += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

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
  maxResponseBytes?: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  if (init.signal?.aborted) throw new RemoteTabError("aborted", "Operation aborted");
  const deadline = performance.now() + timeoutMs;
  let stopped: RemoteTabError | undefined;
  // Snapshot reusable bodies once. Stream and multipart requests get one attempt only.
  let body = init.body;
  const replayable =
    body == null ||
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body);
  if (body instanceof ArrayBuffer) body = body.slice(0);
  else if (ArrayBuffer.isView(body))
    body = new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  else if (body instanceof URLSearchParams) body = new URLSearchParams(body);
  const headers = new Headers(init.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (error: RemoteTabError) => {
      stopped = error;
      reject(error);
      controller.abort();
    };
    onAbort = () => stop(new RemoteTabError("aborted", "Operation aborted"));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => stop(new RemoteTabError("timeout", "HTTP request timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          if (stopped) throw stopped;
          if (performance.now() >= deadline)
            throw new RemoteTabError("timeout", "HTTP request timed out");
          const response = await fetcher(
            new Request(url, {
              ...init,
              body,
              redirect: "error",
              headers,
              signal: controller.signal,
            }),
          );
          // Error envelopes have their own small allowance, independent of a blob's budget.
          const responseLimit = response.ok ? maxResponseBytes : 8 * 1024;
          const bytes =
            responseLimit === undefined
              ? await response.arrayBuffer()
              : await limitedBody(response, responseLimit, controller.signal);
          if (stopped) throw stopped;
          if (performance.now() >= deadline)
            throw new RemoteTabError("timeout", "HTTP request timed out");
          const buffered = new Response(bytes.byteLength ? bytes : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          if (buffered.ok) return buffered;
          const error = await buffered.json().catch(() => ({}));
          const delay = retryAfter(response.headers.get("retry-after"));
          if (
            response.status === 429 &&
            error?.error === "rate_limited" &&
            delay !== null &&
            replayable &&
            delay < deadline - performance.now()
          ) {
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(wait);
                reject(stopped ?? new RemoteTabError("aborted", "Operation aborted"));
              };
              // Even Retry-After: 0 yields to cancellation and the overall timer.
              const wait = setTimeout(
                () => {
                  controller.signal.removeEventListener("abort", abort);
                  resolve();
                },
                Math.max(1, delay),
              );
              controller.signal.addEventListener("abort", abort, { once: true });
              if (controller.signal.aborted) abort();
            });
            continue;
          }
          throw new RemoteTabError(
            error?.error ?? "invalid",
            error?.message ?? `HTTP ${response.status}`,
            response.status,
          );
        }
      })(),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) init.signal?.removeEventListener("abort", onAbort);
  }
}
function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      header,
    )
  )
    return null;
  const date = Date.parse(header);
  return Number.isFinite(date) && new Date(date).toUTCString() === header
    ? Math.max(0, date - Date.now())
    : null;
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
  private ledgerBudget?: LedgerBudget;
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
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => {});
    return pending;
  }
  protected async call(
    path = "",
    init: RequestInit = {},
    timeoutMs = this.options.requestTimeoutMs,
    maxResponseBytes?: number,
  ): Promise<Response> {
    return request(
      this.fetcher,
      `${this.serverUrl}/v1/sessions/${this.sessionId}${path}`,
      this.token,
      init,
      timeoutMs,
      maxResponseBytes ??
        (this.ledgerBudget
          ? Math.max(0, this.ledgerBudget.maxBytes - this.ledgerBudget.usedBytes) + 1024
          : undefined),
    );
  }
  async status(options: WaitOptions = {}): Promise<SessionStatus> {
    return this.readStatus(await this.call("", { signal: options.signal }, options.timeoutMs));
  }
  private async readStatus(response: Response): Promise<SessionStatus> {
    const status = (await response.json()) as SessionStatus;
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
      if (this.ledgerBudget && this.entries.length >= this.ledgerBudget.maxEntries)
        throw ledgerTooLarge();
      if (
        this.ledgerBudget &&
        jsonBytes(message) > this.ledgerBudget.maxBytes - this.ledgerBudget.usedBytes
      )
        throw ledgerTooLarge();
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
      const entry = { message, envelope, attachments: [] };
      if (this.ledgerBudget) charge(this.ledgerBudget, jsonBytes(entry));
      this.entries.push(entry);
    }
  }
  /** Anchors every read to status; the server may append newer messages while paging. */
  protected async refresh(
    waitSeconds = 0,
    budgetMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
    preserveAnchor = false,
  ): Promise<SessionStatus> {
    const deadline = this.options.now() + budgetMs;
    return this.exclusive(async () =>
      this.refreshUnlocked(waitSeconds, this.checkWait(deadline, signal), signal, preserveAnchor),
    );
  }
  private async refreshUnlocked(
    waitSeconds = 0,
    budgetMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
    preserveAnchor = false,
  ): Promise<SessionStatus> {
    const deadline = this.options.now() + budgetMs;
    const anchor = await this.status({ timeoutMs: budgetMs, signal });
    if (this.ledgerBudget && anchor.last_seq > this.ledgerBudget.maxEntries) throw ledgerTooLarge();
    if (this.ledgerBudget) charge(this.ledgerBudget, jsonBytes(anchor));
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
      // Command reads must observe later stop/expiry immediately. A ledger instead
      // binds state to the same captured sequence/hash that its entries will use.
      if (!preserveAnchor && (page.state === "stopped" || page.state === "expired"))
        anchor.state = page.state;
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
          await this.readEcho(deadline, options.signal);
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
  /**
   * The append is already committed here, so a throttled echo read is retried
   * instead of surfaced. Callers can then treat `rate_limited` from an append as
   * "nothing was appended" and safely send again.
   */
  private async readEcho(deadline: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      try {
        await this.refreshUnlocked(0, this.checkWait(deadline, signal), signal);
        return;
      } catch (error) {
        if (!(error instanceof RemoteTabError) || error.code !== "rate_limited") throw error;
        await this.options.sleep(Math.min(1000, this.checkWait(deadline, signal)));
      }
    }
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
  protected async pause(
    deadline: number,
    signal?: AbortSignal,
    intervalMs = this.options.pollIntervalMs,
  ): Promise<void> {
    const ms = Math.min(intervalMs, this.checkWait(deadline, signal));
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
    if (entry.envelope.kind !== "result") return [];
    const body = entry.envelope.body;
    if (!object(body)) throw new RemoteTabError("protocol_invalid", "Invalid result body");
    const deadline = this.deadline(options);
    const found: BlobReference[] = [];
    const addReference = (value: unknown): void => {
      if (
        !object(value) ||
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
    };
    // Only these result-envelope fields are protocol metadata. Tool output and
    // command arguments may contain arbitrary application fields named blob_id.
    if ("screenshot" in body) addReference(body.screenshot);
    if ("blobs" in body) {
      if (!Array.isArray(body.blobs))
        throw new RemoteTabError("protocol_invalid", "Invalid result blobs");
      for (const reference of body.blobs) addReference(reference);
    }
    const attachments: Attachment[] = [];
    for (const reference of found) {
      // AES-GCM adds a 16-byte authentication tag. Bound ciphertext before
      // allocation/decryption, then charge the actual retained plaintext.
      const remaining = this.ledgerBudget
        ? this.ledgerBudget.maxBytes - this.ledgerBudget.usedBytes
        : undefined;
      const bytes = new Uint8Array(
        await (
          await this.call(
            `/blobs/${reference.blob_id}`,
            { signal: options.signal },
            Math.min(this.options.requestTimeoutMs, this.checkWait(deadline, options.signal)),
            remaining === undefined ? undefined : Math.min(LIMITS.blobMaxBytes, remaining + 16),
          )
        ).arrayBuffer(),
      );
      let plaintext: Attachment["bytes"];
      try {
        plaintext = await openBytes(
          await this.key,
          unb64url(reference.nonce),
          bytes,
          messageAad(this.sessionId, reference.role, reference.prev_hash),
        );
      } catch {
        throw new RemoteTabError("decrypt_failed", "Blob authentication failed");
      }
      charge(this.ledgerBudget, plaintext.byteLength);
      attachments.push({ reference, bytes: plaintext });
    }
    return attachments;
  }
  /** Verify from genesis again, then decrypt every referenced blob, including after stop/expiry. */
  async ledger(options: LedgerOptions = {}): Promise<Ledger> {
    for (const limit of [options.maxEntries, options.maxBytes]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        throw new RemoteTabError("invalid", "Ledger limits must be nonnegative safe integers");
    }
    const known = this.tail();
    const reader = new Peer(this.serverUrl, this.sessionId, this.token, this.key, this.role, {
      ...this.options,
      fetch: this.fetcher,
    });
    if (options.maxEntries !== undefined || options.maxBytes !== undefined) {
      reader.ledgerBudget = {
        maxEntries: options.maxEntries ?? Number.POSITIVE_INFINITY,
        maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
        usedBytes: 0,
      };
    }
    const status = await reader.refresh(0, options.timeoutMs, options.signal, true);
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
    for (const entry of reader.entries)
      entry.attachments = await reader.attachments(entry, options);
    // The reader is private to this invocation. Its freshly decoded objects and
    // buffers can be transferred without cloning the complete ledger again.
    return { sessionId: this.sessionId, status, entries: reader.entries };
  }

  /** Stop immediately through the terminal endpoint; ledger status records the outcome. */
  async stop(): Promise<SessionStatus> {
    const status = await this.readStatus(await this.call("/stop", { method: "POST" }));
    if (status.state !== "stopped")
      throw new RemoteTabError("protocol_invalid", "Server did not confirm terminal stop");
    return status;
  }
}
