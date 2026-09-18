import type {
  Attachment,
  BlobReference,
  BrowserPeer,
  Ledger,
  LedgerEntry,
} from "@remote-tab/client";
import { RemoteTabError } from "@remote-tab/client";
import {
  PROTOCOL_VERSION,
  type SessionStatus,
  UUID_V4_RE,
  type WireMessage,
} from "@remote-tab/protocol";
import { b64url, unb64url, verifyChain } from "@remote-tab/protocol/src/crypto";

export const LEDGER_CHUNK_BYTES = 192 * 1024;
export const LEDGER_MAX_METADATA_BYTES = 32 * 1024 * 1024;
export const LEDGER_MAX_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export class LedgerTransferError extends Error {
  constructor(
    public readonly code:
      | "ledger_unavailable"
      | "ledger_invalid"
      | "ledger_too_large"
      | "ledger_busy"
      | "ledger_timeout",
  ) {
    super(
      {
        ledger_unavailable: "This ledger is no longer available in memory.",
        ledger_invalid: "Ledger verification failed. No export was created.",
        ledger_too_large: "This ledger exceeds the viewer's memory limit.",
        ledger_busy: "Other ledgers are still loading. Close a viewer and retry.",
        ledger_timeout: "Ledger loading timed out. Retry while the share remains available.",
      }[code],
    );
    this.name = "LedgerTransferError";
  }
}
const invalid = () => new LedgerTransferError("ledger_invalid");
export type LedgerJobStatus =
  | { state: "loading"; sessionId: string }
  | { state: "ready"; sessionId: string; metadataBytes: number; metadataSha256: string }
  | { state: "error"; code: LedgerTransferError["code"]; message: string };
export interface LedgerChunk {
  offset: number;
  total: number;
  data: string;
}
interface AttachmentMetadata {
  reference: BlobReference;
  byteLength: number;
  sha256: string;
}
interface LedgerMetadata {
  version: 1;
  sessionId: string;
  status: SessionStatus;
  entries: {
    message: WireMessage;
    envelope: LedgerEntry["envelope"];
    attachments: AttachmentMetadata[];
  }[];
}
interface Job {
  controller: AbortController;
  sessionId: string;
  status: LedgerJobStatus;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  metadata?: Uint8Array;
  attachments?: Uint8Array[][];
  bytes: number;
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function reference(value: unknown): BlobReference {
  if (
    !object(value) ||
    typeof value.blob_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(value.blob_id) ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/.test(value.nonce) ||
    !["agent", "browser"].includes(String(value.role)) ||
    typeof value.prev_hash !== "string" ||
    (value.prev_hash !== "" && !SHA.test(value.prev_hash)) ||
    typeof value.mime_type !== "string" ||
    value.mime_type.length > 200
  )
    throw invalid();
  return {
    blob_id: value.blob_id,
    nonce: value.nonce,
    role: value.role as "agent" | "browser",
    prev_hash: value.prev_hash,
    mime_type: value.mime_type,
  };
}
function sameReference(a: BlobReference, b: BlobReference): boolean {
  return (
    a.blob_id === b.blob_id &&
    a.nonce === b.nonce &&
    a.role === b.role &&
    a.prev_hash === b.prev_hash &&
    a.mime_type === b.mime_type
  );
}
function validateMetadata(value: unknown, sessionId: string): LedgerMetadata {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.sessionId !== sessionId ||
    !object(value.status) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  )
    throw invalid();
  const status = value.status;
  if (
    status.id !== sessionId ||
    !["created", "redeemed", "active", "stopped", "expired"].includes(String(status.state)) ||
    typeof status.redeemed !== "boolean" ||
    typeof status.expires_at !== "string" ||
    !Number.isFinite(Date.parse(status.expires_at)) ||
    !integer(status.last_seq, MAX_ENTRIES) ||
    typeof status.last_hash !== "string" ||
    (status.last_hash !== "" && !SHA.test(status.last_hash))
  )
    throw invalid();
  let total = 0;
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      !object(entry.message) ||
      !object(entry.envelope) ||
      !Array.isArray(entry.attachments)
    )
      throw invalid();
    const message = entry.message;
    const envelope = entry.envelope;
    if (
      !integer(message.seq, MAX_ENTRIES) ||
      message.seq === 0 ||
      !["agent", "browser"].includes(String(message.role)) ||
      typeof message.hash !== "string" ||
      !SHA.test(message.hash) ||
      typeof message.prev_hash !== "string" ||
      (message.prev_hash !== "" && !SHA.test(message.prev_hash)) ||
      typeof message.ciphertext !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(message.ciphertext) ||
      message.ciphertext.length > 100000 ||
      typeof message.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{16}$/.test(message.nonce) ||
      typeof message.created_at !== "string" ||
      !Number.isFinite(Date.parse(message.created_at))
    )
      throw invalid();
    const allowed =
      message.role === "agent"
        ? ["command", "handoff", "stop"]
        : ["hello", "result", "handoff_done", "stop"];
    if (
      envelope.v !== PROTOCOL_VERSION ||
      !allowed.includes(String(envelope.kind)) ||
      typeof envelope.id !== "string" ||
      !envelope.id ||
      envelope.id.length > 1000 ||
      !object(envelope.body)
    )
      throw invalid();
    const references: BlobReference[] = [];
    if (envelope.kind === "result") {
      if ("screenshot" in envelope.body) references.push(reference(envelope.body.screenshot));
      if ("blobs" in envelope.body) {
        if (!Array.isArray(envelope.body.blobs)) throw invalid();
        references.push(...envelope.body.blobs.map(reference));
      }
    }
    if (references.length !== entry.attachments.length) throw invalid();
    for (let i = 0; i < entry.attachments.length; i++) {
      const attachment = entry.attachments[i];
      if (
        !object(attachment) ||
        !integer(attachment.byteLength, MAX_ATTACHMENT_BYTES) ||
        typeof attachment.sha256 !== "string" ||
        !SHA.test(attachment.sha256)
      )
        throw invalid();
      const ref = reference(attachment.reference);
      if (
        !sameReference(ref, references[i]) ||
        ref.role !== message.role ||
        ref.prev_hash !== message.prev_hash
      )
        throw invalid();
      total += attachment.byteLength;
      if (total > LEDGER_MAX_BYTES) throw new LedgerTransferError("ledger_too_large");
    }
  }
  if (
    status.last_seq !== value.entries.length ||
    status.last_hash !== (value.entries.at(-1)?.message.hash ?? "")
  )
    throw invalid();
  return value as unknown as LedgerMetadata;
}

/** No persistence: peer/key remain in the worker; only a verified snapshot is transferred. */
export class LedgerJobs {
  private readonly jobs = new Map<string, Job>();
  private cachedBytes = 0;
  private retrieval: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxBytes: number;
  constructor(
    options: { now?: () => number; ttlMs?: number; maxJobs?: number; maxBytes?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxJobs = options.maxJobs ?? 2;
    this.maxBytes = options.maxBytes ?? LEDGER_MAX_BYTES;
    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isInteger(this.maxJobs) ||
      this.maxJobs <= 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes <= 0
    )
      throw invalid();
  }
  create(
    peer: Pick<BrowserPeer, "sessionId" | "ledger">,
    after: Promise<unknown> = Promise.resolve(),
  ): string {
    this.prune();
    if (!UUID_V4_RE.test(peer.sessionId)) throw invalid();
    if (this.jobs.size >= this.maxJobs) throw new LedgerTransferError("ledger_busy");
    const id = crypto.randomUUID();
    const job: Job = {
      controller: new AbortController(),
      sessionId: peer.sessionId,
      status: { state: "loading", sessionId: peer.sessionId },
      expiresAt: this.now() + this.ttlMs,
      timer: setTimeout(() => this.release(id), this.ttlMs),
      bytes: 0,
    };
    this.jobs.set(id, job);
    // A failed remote Stop still permits a verified snapshot labelled with the
    // actual returned status. It must never be represented as confirmed stopped.
    void after
      .catch(() => undefined)
      .then(() => {
        // Only one retrieval may allocate at a time; ready snapshots share its budget.
        this.retrieval = this.retrieval.then(() => this.prepare(id, job, peer));
      });
    return id;
  }
  private async prepare(
    id: string,
    job: Job,
    peer: Pick<BrowserPeer, "sessionId" | "ledger">,
  ): Promise<void> {
    try {
      if (this.jobs.get(id) !== job) return;
      const ledger = await peer.ledger({
        maxEntries: MAX_ENTRIES,
        maxBytes: Math.max(0, this.maxBytes - this.cachedBytes),
        signal: job.controller.signal,
      });
      if (this.jobs.get(id) !== job) return;
      if (
        ledger.sessionId !== job.sessionId ||
        !Array.isArray(ledger.entries) ||
        ledger.entries.length > MAX_ENTRIES
      )
        throw invalid();
      const attachments: Uint8Array[][] = [];
      let bytes = 0;
      const entries: LedgerMetadata["entries"] = [];
      for (const entry of ledger.entries) {
        const outputs: AttachmentMetadata[] = [];
        const buffers: Uint8Array[] = [];
        for (const attachment of entry.attachments) {
          if (
            !(attachment.bytes instanceof Uint8Array) ||
            attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES
          )
            throw invalid();
          bytes += attachment.bytes.byteLength;
          if (bytes > this.maxBytes) throw new LedgerTransferError("ledger_too_large");
          buffers.push(attachment.bytes);
          outputs.push({
            reference: reference(attachment.reference),
            byteLength: attachment.bytes.byteLength,
            sha256: await digest(attachment.bytes),
          });
        }
        attachments.push(buffers);
        entries.push({ message: entry.message, envelope: entry.envelope, attachments: outputs });
      }
      const data = { version: 1, sessionId: ledger.sessionId, status: ledger.status, entries };
      validateMetadata(data, job.sessionId);
      const metadata = encoder.encode(JSON.stringify(data));
      if (metadata.length > LEDGER_MAX_METADATA_BYTES)
        throw new LedgerTransferError("ledger_too_large");
      bytes += metadata.byteLength;
      const metadataSha256 = await digest(metadata);
      this.prune();
      if (this.jobs.get(id) !== job) return;
      if (this.cachedBytes + bytes > this.maxBytes)
        throw new LedgerTransferError("ledger_too_large");
      this.cachedBytes += bytes;
      Object.assign(job, {
        metadata,
        attachments,
        bytes,
        status: {
          state: "ready",
          sessionId: ledger.sessionId,
          metadataBytes: metadata.byteLength,
          metadataSha256,
        },
      });
    } catch (error) {
      if (this.jobs.get(id) !== job) return;
      const safe =
        error instanceof LedgerTransferError
          ? error
          : new LedgerTransferError(
              error instanceof RemoteTabError && error.code === "ledger_too_large"
                ? "ledger_too_large"
                : "ledger_unavailable",
            );
      job.status = { state: "error", code: safe.code, message: safe.message };
    }
  }
  private prune(): void {
    for (const [id, job] of this.jobs) if (job.expiresAt <= this.now()) this.release(id);
  }
  status(id: string): LedgerJobStatus {
    this.prune();
    const status = this.jobs.get(id)?.status;
    if (status) return { ...status };
    const error = new LedgerTransferError("ledger_unavailable");
    return { state: "error", code: error.code, message: error.message };
  }
  chunk(
    id: string,
    kind: "metadata" | "attachment",
    offset: number,
    entry?: number,
    attachment?: number,
  ): LedgerChunk {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.status.state !== "ready") throw new LedgerTransferError("ledger_unavailable");
    let bytes: Uint8Array | undefined;
    if (kind === "metadata" && entry === undefined && attachment === undefined)
      bytes = job.metadata;
    else if (
      kind === "attachment" &&
      integer(entry, MAX_ENTRIES) &&
      integer(attachment, MAX_ENTRIES)
    )
      bytes = job.attachments?.[entry]?.[attachment];
    if (!bytes || !integer(offset, bytes.length) || (offset === bytes.length && offset !== 0))
      throw invalid();
    return {
      offset,
      total: bytes.length,
      data: b64url(bytes.subarray(offset, offset + LEDGER_CHUNK_BYTES)),
    };
  }
  release(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.controller.abort();
    this.cachedBytes -= job.bytes;
    this.jobs.delete(id);
  }
}

export type LedgerRpc = (message: unknown) => Promise<unknown>;
/** Only returns after the worker-authenticated snapshot and every transferred byte verify. */
export async function loadLedger(
  jobId: string,
  rpc: LedgerRpc,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Ledger> {
  if (!UUID_V4_RE.test(jobId)) throw invalid();
  const timeoutMs = options.timeoutMs ?? 180000;
  const pollMs = options.pollMs ?? 500;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs < 0)
    throw invalid();
  const deadline = Date.now() + timeoutMs;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function call(message: unknown, budgetMs = timeoutMs): Promise<unknown> {
    const remaining = Math.min(deadline - Date.now(), budgetMs);
    if (remaining <= 0) throw new LedgerTransferError("ledger_timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        rpc(message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LedgerTransferError("ledger_timeout")), remaining);
        }),
      ]);
    } catch (error) {
      throw error instanceof LedgerTransferError
        ? error
        : new LedgerTransferError("ledger_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  let state: Record<string, unknown>;
  let sessionId: string | undefined;
  while (true) {
    const response = await call({ action: "ledger-status", jobId });
    if (!object(response)) throw invalid();
    if (response.state === "error")
      throw new LedgerTransferError(
        response.code === "ledger_too_large" || response.code === "ledger_invalid"
          ? response.code
          : "ledger_unavailable",
      );
    if (
      typeof response.sessionId !== "string" ||
      !UUID_V4_RE.test(response.sessionId) ||
      (sessionId !== undefined && sessionId !== response.sessionId)
    )
      throw invalid();
    sessionId = response.sessionId;
    if (response.state === "ready") {
      state = response;
      break;
    }
    if (
      response.state !== "loading" ||
      typeof response.sessionId !== "string" ||
      !UUID_V4_RE.test(response.sessionId)
    )
      throw invalid();
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  if (
    typeof state.sessionId !== "string" ||
    !UUID_V4_RE.test(state.sessionId) ||
    !integer(state.metadataBytes, LEDGER_MAX_METADATA_BYTES) ||
    state.metadataBytes === 0 ||
    typeof state.metadataSha256 !== "string" ||
    !SHA.test(state.metadataSha256)
  )
    throw invalid();
  async function read(
    kind: "metadata" | "attachment",
    total: number,
    entry?: number,
    attachment?: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    while (offset < total) {
      const chunk = await call({
        action: "ledger-chunk",
        jobId,
        kind,
        offset,
        ...(entry === undefined ? {} : { entry, attachment }),
      });
      if (
        !object(chunk) ||
        chunk.offset !== offset ||
        chunk.total !== total ||
        typeof chunk.data !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(chunk.data) ||
        chunk.data.length > Math.ceil((LEDGER_CHUNK_BYTES * 4) / 3)
      )
        throw invalid();
      let bytes: Uint8Array;
      try {
        bytes = unb64url(chunk.data);
      } catch {
        throw invalid();
      }
      if (
        !bytes.length ||
        bytes.length > LEDGER_CHUNK_BYTES ||
        bytes.length > total - offset ||
        b64url(bytes) !== chunk.data
      )
        throw invalid();
      output.set(bytes, offset);
      offset += bytes.length;
    }
    return output;
  }
  const bytes = await read("metadata", state.metadataBytes);
  if ((await digest(bytes)) !== state.metadataSha256) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  const metadata = validateMetadata(decoded, state.sessionId);
  const chain = await verifyChain(
    metadata.sessionId,
    metadata.entries.map(({ message }) => ({ ...message, prevHash: message.prev_hash })),
  );
  if (!chain.ok) throw invalid();
  let allocated = bytes.byteLength;
  const entries: LedgerEntry[] = [];
  for (const [entryIndex, entry] of metadata.entries.entries()) {
    const attachments: Attachment[] = [];
    for (const [attachmentIndex, attachment] of entry.attachments.entries()) {
      allocated += attachment.byteLength;
      if (allocated > LEDGER_MAX_BYTES) throw new LedgerTransferError("ledger_too_large");
      const data = await read("attachment", attachment.byteLength, entryIndex, attachmentIndex);
      if ((await digest(data)) !== attachment.sha256) throw invalid();
      attachments.push({ reference: attachment.reference, bytes: data });
    }
    entries.push({ message: entry.message, envelope: entry.envelope, attachments });
  }
  // Release is an acknowledgement after complete verification. A worker that
  // disappears now does not invalidate the page's independent in-memory copy.
  await call({ action: "ledger-release", jobId }, 1000).catch(() => undefined);
  return { sessionId: metadata.sessionId, status: metadata.status, entries };
}
