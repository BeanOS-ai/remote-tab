import { afterEach, expect, test } from "bun:test";
import type { BlobReference, Ledger } from "@remote-tab/client";
import {
  b64url,
  chainHash,
  deriveSessionId,
  randomSecret,
  unb64url,
} from "@remote-tab/protocol/src/crypto";
import { LEDGER_CHUNK_BYTES, LedgerJobs, type LedgerRpc, loadLedger } from "./ledger-data";

const ids: [LedgerJobs, string][] = [];
afterEach(() => {
  for (const [jobs, id] of ids.splice(0)) jobs.release(id);
});
function create(jobs: LedgerJobs, ledger: Ledger, after?: Promise<unknown>) {
  const id = jobs.create(
    { sessionId: ledger.sessionId, ledger: async () => structuredClone(ledger) },
    after,
  );
  ids.push([jobs, id]);
  return id;
}
async function ready(jobs: LedgerJobs, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const state = jobs.status(id);
    if (state.state !== "loading") return state;
    await Bun.sleep(1);
  }
  throw new Error("Job did not settle");
}
function transport(jobs: LedgerJobs, releases: string[] = []): LedgerRpc {
  return async (value) => {
    const m = value as {
      action: string;
      jobId: string;
      kind: "metadata" | "attachment";
      offset: number;
      entry?: number;
      attachment?: number;
    };
    if (m.action === "ledger-status") return jobs.status(m.jobId);
    if (m.action === "ledger-chunk")
      return jobs.chunk(m.jobId, m.kind, m.offset, m.entry, m.attachment);
    if (m.action === "ledger-release") {
      releases.push(m.jobId);
      jobs.release(m.jobId);
      return {};
    }
    throw new Error("Unknown RPC");
  };
}
async function fixture(size = 12, text = "Safe result"): Promise<Ledger> {
  const sessionId = await deriveSessionId(randomSecret());
  const reference: BlobReference = {
    blob_id: "b".repeat(32),
    nonce: "n".repeat(16),
    role: "browser",
    prev_hash: "",
    mime_type: "image/png",
  };
  const ciphertext = b64url(new TextEncoder().encode("authenticated by the worker"));
  const hash = await chainHash(sessionId, 1, ciphertext);
  return {
    sessionId,
    status: {
      id: sessionId,
      state: "stopped",
      expires_at: "2026-10-01T00:00:00Z",
      last_seq: 1,
      last_hash: hash,
      redeemed: true,
    },
    entries: [
      {
        message: {
          seq: 1,
          role: "browser",
          prev_hash: "",
          hash,
          nonce: "n".repeat(16),
          ciphertext,
          created_at: "2026-09-18T00:00:00Z",
        },
        envelope: {
          v: 1,
          id: crypto.randomUUID(),
          kind: "result",
          body: { ok: true, result: { text }, screenshot: reference },
        },
        attachments: [{ reference, bytes: new Uint8Array(size).map((_, i) => i % 251) }],
      },
    ],
  };
}

test("chunks metadata and attachments, verifies and releases a complete independent snapshot", async () => {
  const original = await fixture(LEDGER_CHUNK_BYTES + 31, "x".repeat(LEDGER_CHUNK_BYTES + 7));
  const jobs = new LedgerJobs();
  const id = create(jobs, original);
  const releases: string[] = [];
  const rpc = transport(jobs, releases);
  const kinds: string[] = [];
  const restored = await loadLedger(
    id,
    async (message) => {
      const m = message as { action: string; kind: string };
      const result = await rpc(message);
      if (m.action === "ledger-chunk") {
        kinds.push(m.kind);
        expect(unb64url((result as { data: string }).data).length).toBeLessThanOrEqual(
          LEDGER_CHUNK_BYTES,
        );
      }
      return JSON.parse(JSON.stringify(result));
    },
    { pollMs: 0 },
  );
  expect(restored).toEqual(original);
  expect(kinds.filter((kind) => kind === "metadata").length).toBeGreaterThan(1);
  expect(kinds.filter((kind) => kind === "attachment").length).toBe(2);
  expect(releases).toEqual([id]);
  expect(jobs.status(id).state).toBe("error");
  original.entries[0].attachments[0].bytes.fill(255);
  expect(restored.entries[0].attachments[0].bytes[0]).toBe(0);
});

test("job waits for Stop, binds its original peer and snapshots bytes immutably", async () => {
  const first = await fixture();
  const next = await fixture();
  const jobs = new LedgerJobs();
  let finishStop = () => {};
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  let calls = 0;
  let active = {
    sessionId: first.sessionId,
    ledger: async () => {
      calls++;
      return structuredClone(first);
    },
  };
  const id = jobs.create(active, stopped);
  ids.push([jobs, id]);
  active = { sessionId: next.sessionId, ledger: async () => next };
  expect(active.sessionId).toBe(next.sessionId);
  await Bun.sleep(1);
  expect(calls).toBe(0);
  expect(jobs.status(id).state).toBe("loading");
  finishStop();
  expect((await ready(jobs, id)).state).toBe("ready");
  const expected = structuredClone(first);
  first.entries[0].attachments[0].bytes.fill(255);
  first.entries[0].envelope.body = { result: "mutated source" };
  expect(await loadLedger(id, transport(jobs))).toEqual(expected);
});

test("failed Stop exports the actual nonterminal status, never a fabricated stopped status", async () => {
  const ledger = await fixture();
  ledger.status.state = "active";
  const jobs = new LedgerJobs();
  const id = create(jobs, ledger, Promise.reject(new Error("remote unavailable")));
  expect((await loadLedger(id, transport(jobs), { pollMs: 0 })).status.state).toBe("active");
});

for (const kind of ["metadata", "attachment"] as const) {
  test(`${kind} transfer tampering fails before release`, async () => {
    const jobs = new LedgerJobs();
    const id = create(jobs, await fixture());
    const releases: string[] = [];
    const rpc = transport(jobs, releases);
    await expect(
      loadLedger(
        id,
        async (message) => {
          const response = await rpc(message);
          const m = message as { action: string; kind: string };
          if (m.action === "ledger-chunk" && m.kind === kind) {
            const chunk = response as { data: string };
            const bytes = unb64url(chunk.data);
            bytes[0] ^= 1;
            return { ...chunk, data: b64url(bytes) };
          }
          return response;
        },
        { pollMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "ledger_invalid" });
    expect(releases).toEqual([]);
    expect(jobs.status(id).state).toBe("ready");
  });
}

for (const mode of ["empty", "missing", "offset", "total", "oversize"] as const) {
  test(`rejects ${mode} chunks without returning or releasing partial data`, async () => {
    const jobs = new LedgerJobs();
    const id = create(jobs, await fixture());
    const releases: string[] = [];
    const rpc = transport(jobs, releases);
    await expect(
      loadLedger(
        id,
        async (message) => {
          const response = await rpc(message);
          if ((message as { action: string }).action !== "ledger-chunk") return response;
          const chunk = response as { data: string; offset: number; total: number };
          if (mode === "missing") return undefined;
          if (mode === "empty") return { ...chunk, data: "" };
          if (mode === "offset") return { ...chunk, offset: 1 };
          if (mode === "total") return { ...chunk, total: chunk.total + 1 };
          return { ...chunk, data: "a".repeat(LEDGER_CHUNK_BYTES * 2) };
        },
        { pollMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "ledger_invalid" });
    expect(releases).toEqual([]);
  });
}

for (const corruption of [
  "gap",
  "ciphertext",
  "prev_hash",
  "last_seq",
  "last_hash",
  "reference",
  "session",
] as const) {
  test(`rejects ledger ${corruption} corruption even with authentic transport checksums`, async () => {
    const ledger = await fixture();
    if (corruption === "gap") ledger.entries[0].message.seq = 2;
    if (corruption === "ciphertext") ledger.entries[0].message.ciphertext = "dGFtcGVyZWQ";
    if (corruption === "prev_hash") {
      ledger.entries[0].message.prev_hash = "a".repeat(64);
      ledger.entries[0].attachments[0].reference.prev_hash = "a".repeat(64);
    }
    if (corruption === "last_seq") ledger.status.last_seq = 2;
    if (corruption === "last_hash") ledger.status.last_hash = "a".repeat(64);
    if (corruption === "reference")
      ledger.entries[0].attachments[0].reference = {
        ...ledger.entries[0].attachments[0].reference,
        blob_id: "x".repeat(32),
      };
    if (corruption === "session") ledger.status.id = await deriveSessionId(randomSecret());
    const jobs = new LedgerJobs();
    const id = create(jobs, ledger);
    const releases: string[] = [];
    await expect(loadLedger(id, transport(jobs, releases), { pollMs: 0 })).rejects.toThrow();
    expect(releases).toEqual([]);
  });
}

test("job enforces immutable session binding even if the supplied peer is mutated", async () => {
  const ledger = await fixture();
  const jobs = new LedgerJobs();
  let resume = () => {};
  const after = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const peer = { sessionId: ledger.sessionId, ledger: async () => ledger };
  const id = jobs.create(peer, after);
  ids.push([jobs, id]);
  peer.sessionId = await deriveSessionId(randomSecret());
  ledger.sessionId = peer.sessionId;
  ledger.status.id = peer.sessionId;
  resume();
  expect(await ready(jobs, id)).toMatchObject({ state: "error", code: "ledger_invalid" });
});

test("count, TTL and aggregate memory bounds fail clearly and release frees capacity", async () => {
  let now = 0;
  const ledger = await fixture();
  const jobs = new LedgerJobs({ now: () => now, ttlMs: 100, maxJobs: 1 });
  const id = create(jobs, ledger);
  expect(() => create(jobs, ledger)).toThrow("Other ledgers");
  await ready(jobs, id);
  now = 101;
  expect(jobs.status(id)).toMatchObject({ state: "error", code: "ledger_unavailable" });
  const next = create(jobs, ledger);
  expect((await ready(jobs, next)).state).toBe("ready");
  const limited = new LedgerJobs({ maxBytes: 10 });
  expect(await ready(limited, create(limited, ledger))).toMatchObject({
    state: "error",
    code: "ledger_too_large",
  });
  const size = (jobs.status(next) as { metadataBytes: number }).metadataBytes + 12;
  const aggregate = new LedgerJobs({ maxBytes: size });
  const one = create(aggregate, ledger);
  expect((await ready(aggregate, one)).state).toBe("ready");
  const two = create(aggregate, ledger);
  expect(await ready(aggregate, two)).toMatchObject({ state: "error", code: "ledger_too_large" });
  aggregate.release(one);
  const three = create(aggregate, ledger);
  expect((await ready(aggregate, three)).state).toBe("ready");
});

test("release while fetching cannot republish the job; errors never echo transport secrets", async () => {
  const ledger = await fixture();
  const jobs = new LedgerJobs();
  let finish = (_ledger: Ledger) => {};
  const pending = new Promise<Ledger>((resolve) => {
    finish = resolve;
  });
  const id = jobs.create({ sessionId: ledger.sessionId, ledger: () => pending });
  jobs.release(id);
  finish(ledger);
  await Bun.sleep(1);
  expect(jobs.status(id).state).toBe("error");
  const failed = jobs.create({
    sessionId: ledger.sessionId,
    ledger: async () => {
      throw new Error("private bearer");
    },
  });
  ids.push([jobs, failed]);
  expect(JSON.stringify(await ready(jobs, failed))).not.toContain("private bearer");
  await expect(
    loadLedger(crypto.randomUUID(), async () => {
      throw new Error("private bearer");
    }),
  ).rejects.toMatchObject({
    code: "ledger_unavailable",
    message: "This ledger is no longer available in memory.",
  });
});

test("timeouts are bounded, status cannot change session, and a lost release ack preserves verified data", async () => {
  await expect(
    loadLedger(crypto.randomUUID(), () => new Promise(() => {}), { timeoutMs: 5 }),
  ).rejects.toMatchObject({ code: "ledger_timeout" });
  const ledger = await fixture();
  const jobs = new LedgerJobs();
  const id = create(jobs, ledger);
  await ready(jobs, id);
  let first = true;
  const rpc = transport(jobs);
  await expect(
    loadLedger(
      id,
      async (message) => {
        if (first) {
          first = false;
          return { state: "loading", sessionId: await deriveSessionId(randomSecret()) };
        }
        return rpc(message);
      },
      { pollMs: 0 },
    ),
  ).rejects.toMatchObject({ code: "ledger_invalid" });
  const restored = await loadLedger(id, async (message) => {
    if ((message as { action: string }).action === "ledger-release")
      throw new Error("worker stopped");
    return rpc(message);
  });
  expect(restored).toEqual(ledger);
});

test("jobs pass retrieval limits, serialize allocations, abort released downloads and map budget failures safely", async () => {
  const ledger = await fixture();
  const jobs = new LedgerJobs();
  let captured: import("@remote-tab/client").LedgerOptions | undefined;
  let rejectFirst = (_error: Error) => {};
  const first = jobs.create({
    sessionId: ledger.sessionId,
    ledger: (options) => {
      captured = options;
      return new Promise((_resolve, reject) => {
        rejectFirst = reject;
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted private download")),
          { once: true },
        );
      });
    },
  });
  ids.push([jobs, first]);
  let secondStarted = false;
  const second = jobs.create({
    sessionId: ledger.sessionId,
    ledger: async () => {
      secondStarted = true;
      return structuredClone(ledger);
    },
  });
  ids.push([jobs, second]);
  await Bun.sleep(1);
  expect(captured).toMatchObject({ maxEntries: 5000, maxBytes: 96 * 1024 * 1024 });
  expect(captured?.signal?.aborted).toBe(false);
  expect(secondStarted).toBe(false);
  jobs.release(first);
  expect(captured?.signal?.aborted).toBe(true);
  rejectFirst(new Error("cleanup"));
  expect((await ready(jobs, second)).state).toBe("ready");
  const { RemoteTabError } = await import("@remote-tab/client");
  const failed = jobs.create({
    sessionId: ledger.sessionId,
    ledger: async () => {
      throw new RemoteTabError("ledger_too_large", "private server message");
    },
  });
  ids.push([jobs, failed]);
  expect(await ready(jobs, failed)).toMatchObject({ state: "error", code: "ledger_too_large" });
  expect(JSON.stringify(jobs.status(failed))).not.toContain("private server message");
});
