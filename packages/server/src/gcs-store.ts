// Google Cloud Storage store. Objects:
//   sessions/{id}/state.json         session record (CAS via ifGenerationMatch)
//   sessions/{id}/msgs/{seq:08d}.json stored message (create-only: ifGenerationMatch=0)
//   sessions/{id}/blobs/{blobId}      ciphertext bytes
// Sequence assignment: the state object is the cursor. append = CAS on
// state.json (lastSeq/lastHash) then create-only write of the message object.
// A bucket lifecycle rule deletes sessions/ objects 24h after they are written
// past expiry (design §5.3); the server does not delete.
import type { Role } from "@remote-tab/protocol";
import { ChainMismatch, type SessionRecord, type Store, type StoredMessage } from "./store";

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

  async createSession(record: SessionRecord): Promise<void> {
    const r = await this.writeJson(`sessions/${record.id}/state.json`, record, "0");
    if (!r.ok) throw new Error("duplicate session id");
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.readJson<SessionRecord>(`sessions/${id}/state.json`))?.value ?? null;
  }

  async updateSession(
    id: string,
    mutate: (current: SessionRecord) => SessionRecord | null,
  ): Promise<SessionRecord | null> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.readJson<SessionRecord>(`sessions/${id}/state.json`);
      if (!cur) return null;
      const next = mutate({ ...cur.value });
      if (!next) return null;
      const r = await this.writeJson(`sessions/${id}/state.json`, next, cur.generation);
      if (r.ok) return next;
    }
    throw new Error("gcs updateSession: too many concurrent modifications");
  }

  async appendMessage(
    id: string,
    input: { role: Role; prevHash: string; nonce: string; ciphertext: string },
    hashFor: (seq: number) => Promise<string>,
  ): Promise<StoredMessage> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.readJson<SessionRecord>(`sessions/${id}/state.json`);
      if (!cur) throw new Error("no such session");
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
      // Reserve the sequence number first (CAS on the cursor), then write the
      // message object create-only. A crash between the two leaves a gap the
      // reader reports as a chain error rather than silently skipping.
      const reserved = await this.writeJson(
        `sessions/${id}/state.json`,
        { ...cur.value, lastSeq: seq, lastHash: hash },
        cur.generation,
      );
      if (!reserved.ok) continue;
      const wrote = await this.writeJson(
        `sessions/${id}/msgs/${String(seq).padStart(8, "0")}.json`,
        stored,
        "0",
      );
      if (!wrote.ok) throw new Error(`gcs append: message ${seq} already exists`);
      return stored;
    }
    throw new Error("gcs appendMessage: too many concurrent modifications");
  }

  async listMessages(id: string, afterSeq: number, limit: number): Promise<StoredMessage[]> {
    const out: StoredMessage[] = [];
    for (let seq = afterSeq + 1; out.length < limit; seq++) {
      const m = await this.readJson<StoredMessage>(
        `sessions/${id}/msgs/${String(seq).padStart(8, "0")}.json`,
      );
      if (!m) break;
      out.push(m.value);
    }
    return out;
  }

  async putBlob(id: string, blobId: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
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
