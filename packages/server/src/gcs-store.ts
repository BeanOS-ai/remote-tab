// GCS cursor publication: write an immutable candidate first, then CAS state.json
// to reference it. Losing/crashed candidates are unreachable and left to bucket
// lifecycle cleanup; deleting them here could race a successful publication.
//   sessions/{id}/state.json          session record + committed message pointer
//   sessions/{id}/msgs/{uuid}.json    message + previous committed object pointer
//   sessions/{id}/blobs/{blobId}       ciphertext bytes
import type { Role } from "@remote-tab/protocol";
import {
  ChainMismatch,
  RateLimited,
  type SessionAdmission,
  SessionIdTaken,
  SessionNotActive,
  type SessionRecord,
  type Store,
  type StoredMessage,
} from "./store";

interface GcsSessionRecord extends SessionRecord {
  lastMessageObject: string | null;
}

interface GcsMessage {
  message: StoredMessage;
  previousObject: string | null;
}

// One generation-CAS object serializes capacity decisions across every instance.
// Exclude admission/ from bucket lifecycle deletion. Pre-upgrade sessions have no
// reservation; drain older writers and let those sessions expire during rollout.
// Reservations precede state creation/extension. Failed or ambiguous writes may
// leave a conservative reservation until expiry, but cannot over-admit sessions.
type AdmissionIndex = Record<string, { clientIp: string; expiresAt: string }>;
const admissionObject = "admission/active-sessions.json";

export interface GcsStoreOptions {
  bucket: string;
  /** Returns a bearer token for the storage JSON API (ADC, metadata server, or a test stub). */
  token: () => Promise<string>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Base URL, injectable for tests. */
  baseUrl?: string;
  /** Poll interval for waitForMessage. */
  pollMs?: number;
}

export class GcsStore implements Store {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly pollMs: number;

  constructor(private readonly opts: GcsStoreOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.base = (opts.baseUrl ?? "https://storage.googleapis.com").replace(/\/$/, "");
    this.pollMs = opts.pollMs ?? 250;
  }

  private objectUrl(name: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams(query).toString();
    return `${this.base}/storage/v1/b/${encodeURIComponent(this.opts.bucket)}/o/${encodeURIComponent(name)}${q ? `?${q}` : ""}`;
  }

  private uploadUrl(name: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams({ uploadType: "media", name, ...query }).toString();
    return `${this.base}/upload/storage/v1/b/${encodeURIComponent(this.opts.bucket)}/o?${q}`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.opts.token()}`, ...extra };
  }

  private async readJson<T>(name: string): Promise<{ value: T; generation: string } | null> {
    const res = await this.fetchFn(this.objectUrl(name, { alt: "media" }), {
      headers: await this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs read ${name}: HTTP ${res.status}`);
    const generation = res.headers.get("x-goog-generation") ?? "";
    return { value: (await res.json()) as T, generation };
  }

  private async writeJson(
    name: string,
    value: unknown,
    ifGenerationMatch: string | null,
  ): Promise<{ ok: true; generation: string } | { ok: false; conflict: true }> {
    const query: Record<string, string> = {};
    if (ifGenerationMatch !== null) query.ifGenerationMatch = ifGenerationMatch;
    const res = await this.fetchFn(this.uploadUrl(name, query), {
      method: "POST",
      headers: await this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(value),
    });
    if (res.status === 412) return { ok: false, conflict: true };
    if (!res.ok) throw new Error(`gcs write ${name}: HTTP ${res.status}`);
    const meta = (await res.json()) as { generation?: string };
    return { ok: true, generation: meta.generation ?? "" };
  }

  private async changeAdmission(
    mutate: (index: AdmissionIndex) => AdmissionIndex | null,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.readJson<AdmissionIndex>(admissionObject);
      const next = mutate(current?.value ?? {});
      if (!next) return false;
      const result = await this.writeJson(admissionObject, next, current?.generation ?? "0");
      if (result.ok) return true;
    }
    throw new RateLimited();
  }

  async createSession(record: SessionRecord, admission?: SessionAdmission): Promise<void> {
    // Retained terminal IDs remain unavailable and must not reserve capacity again.
    // The create-only state write and admission CAS still arbitrate concurrent creators.
    if (await this.getSession(record.id)) throw new SessionIdTaken();
    if (admission) {
      await this.changeAdmission((index) => {
        const live = Object.fromEntries(
          Object.entries(index).filter(
            ([, entry]) => Date.parse(entry.expiresAt) > admission.now.getTime(),
          ),
        );
        if (Object.hasOwn(live, record.id)) throw new SessionIdTaken();
        const entries = Object.values(live);
        if (
          entries.length >= admission.activeMax ||
          entries.filter((entry) => entry.clientIp === admission.clientIp).length >=
            admission.activePerIp
        ) {
          throw new RateLimited();
        }
        live[record.id] = { clientIp: admission.clientIp, expiresAt: record.expiresAt };
        return live;
      });
    }
    const r = await this.writeJson(
      `sessions/${record.id}/state.json`,
      { ...record, ...(admission && { clientIp: admission.clientIp }), lastMessageObject: null },
      "0",
    );
    if (!r.ok) throw new SessionIdTaken();
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.readJson<GcsSessionRecord>(`sessions/${id}/state.json`))?.value ?? null;
  }

  async updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.readJson<GcsSessionRecord>(`sessions/${id}/state.json`);
      if (!cur) return null;
      const next = mutate({ ...cur.value });
      if (!next) return null;
      if (cur.value.clientIp && Date.parse(next.expiresAt) > Date.parse(cur.value.expiresAt)) {
        const reserved = await this.changeAdmission((index) => {
          if (!Object.hasOwn(index, id)) return null;
          const entry = index[id];
          return {
            ...index,
            [id]: {
              ...entry,
              expiresAt:
                Date.parse(entry.expiresAt) > Date.parse(next.expiresAt)
                  ? entry.expiresAt
                  : next.expiresAt,
            },
          };
        });
        // A concurrent admission already reclaimed the expired reservation.
        if (!reserved) return null;
      }
      const r = await this.writeJson(
        `sessions/${id}/state.json`,
        { ...next, lastMessageObject: cur.value.lastMessageObject },
        cur.generation,
      );
      if (r.ok) {
        if (cur.value.clientIp && (next.state === "stopped" || next.state === "expired")) {
          await this.changeAdmission((index) => {
            const remaining = { ...index };
            delete remaining[id];
            return remaining;
          });
        }
        return next;
      }
    }
    throw new Error("gcs updateSession: too many concurrent modifications");
  }

  async appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
    messagesMax = Number.POSITIVE_INFINITY,
  ): Promise<StoredMessage> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.readJson<GcsSessionRecord>(`sessions/${id}/state.json`);
      if (!cur) throw new Error("no such session");
      if (cur.value.state !== "active") throw new SessionNotActive();
      if (cur.value.lastSeq >= messagesMax) throw new RateLimited();
      if (input.prevHash !== cur.value.lastHash) throw new ChainMismatch(cur.value.lastHash);
      const seq = cur.value.lastSeq + 1;
      const hash = await hashFor(seq);
      const stored: StoredMessage = {
        seq,
        role: input.role,
        prevHash: input.prevHash,
        hash,
        nonce: input.nonce,
        ciphertext: input.ciphertext,
        createdAt: new Date().toISOString(),
      };
      const messageObject = `sessions/${id}/msgs/${crypto.randomUUID()}.json`;
      const wrote = await this.writeJson(
        messageObject,
        { message: stored, previousObject: cur.value.lastMessageObject } satisfies GcsMessage,
        "0",
      );
      if (!wrote.ok) throw new Error("gcs append: candidate object already exists");
      // This CAS is the commit point. No cursor ever references an incomplete
      // upload. On conflict, reread state to observe a competing append or stop.
      const committed = await this.writeJson(
        `sessions/${id}/state.json`,
        { ...cur.value, lastSeq: seq, lastHash: hash, lastMessageObject: messageObject },
        cur.generation,
      );
      if (!committed.ok) continue;
      return stored;
    }
    throw new Error("gcs appendMessage: too many concurrent modifications");
  }

  async listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]> {
    const cursor = await this.readJson<GcsSessionRecord>(`sessions/${id}/state.json`);
    if (!cursor || limit <= 0 || afterSeq >= cursor.value.lastSeq) return [];
    const out: StoredMessage[] = [];
    let object = cursor.value.lastMessageObject;
    let expectedHash = cursor.value.lastHash;
    // Follow one committed snapshot backwards; never expose orphan candidates.
    // A page costs O(lastSeq - afterSeq) reads, including entries past its limit.
    for (let seq = cursor.value.lastSeq; seq > afterSeq; seq--) {
      if (!object) throw new Error(`gcs listMessages: missing committed message ${seq}`);
      const entry = await this.readJson<GcsMessage>(object);
      if (!entry) throw new Error(`gcs listMessages: missing committed message ${seq}`);
      const { message, previousObject } = entry.value;
      if (message.seq !== seq || message.hash !== expectedHash) {
        throw new Error(`gcs listMessages: invalid committed message ${seq}`);
      }
      out.push(message);
      object = previousObject;
      expectedHash = message.prevHash;
    }
    return out.reverse().slice(0, limit);
  }

  async putBlob(
    id: string,
    blobId: string,
    bytes: Uint8Array<ArrayBuffer>,
    budgetBytes = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    // Reserve before upload; concurrent writers share the state generation CAS.
    // Never refund on upload failure: a lost acknowledgement may mean GCS stored
    // the bytes. Duplicate blob IDs also consume budget, bounding upload traffic.
    const reserved = await this.updateSession(id, (session) => {
      if (session.state !== "active") throw new SessionNotActive();
      const blobBytes = (session.blobBytes ?? 0) + bytes.byteLength;
      if (blobBytes > budgetBytes) throw new RateLimited();
      return { ...session, blobBytes };
    });
    if (!reserved) throw new SessionNotActive();
    const res = await this.fetchFn(
      this.uploadUrl(`sessions/${id}/blobs/${blobId}`, { ifGenerationMatch: "0" }),
      {
        method: "POST",
        headers: await this.headers({ "Content-Type": "application/octet-stream" }),
        body: bytes,
      },
    );
    if (!res.ok && res.status !== 412) throw new Error(`gcs putBlob: HTTP ${res.status}`);
  }

  async getBlob(id: string, blobId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const res = await this.fetchFn(
      this.objectUrl(`sessions/${id}/blobs/${blobId}`, { alt: "media" }),
      {
        headers: await this.headers(),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs getBlob: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async waitForMessage(id: string, afterSeq: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.getSession(id);
      if (!s || s.lastSeq > afterSeq || s.state === "stopped") return;
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, deadline - Date.now())));
    }
  }
}
