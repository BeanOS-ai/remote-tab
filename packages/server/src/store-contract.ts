import { describe, expect, test } from "bun:test";
import { chainHash, verifyChain } from "@remote-tab/protocol/src/crypto";
import {
  ChainMismatch,
  RateLimited,
  SessionIdTaken,
  SessionNotActive,
  type SessionRecord,
  type Store,
} from "./store";

export interface StorePair {
  a: Store;
  b: Store;
  close(): Promise<void>;
  trace?(phase: string): void;
}
export type StoreFactory = (now: () => Date, title: string) => Promise<StorePair>;
export const newSessionId = () => crypto.randomUUID().replaceAll("-", "");
export function sessionRecord(now: Date, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: newSessionId(),
    platform: "test",
    state: "active",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 1_800_000).toISOString(),
    redeemUntil: new Date(now.getTime() + 600_000).toISOString(),
    ttlSeconds: 1800,
    agentTokenHash: "agent",
    browserTokenHash: "browser",
    lastSeq: 0,
    lastHash: "",
    ...overrides,
  };
}
export function append(
  store: Store,
  id: string,
  ciphertext = "first",
  prevHash = "",
  cap?: number,
) {
  return store.appendMessage(
    id,
    { role: "agent", prevHash, nonce: "nonce", ciphertext },
    (seq) => chainHash(id, seq, ciphertext),
    cap,
  );
}

// Await SDK I/O before constructing a Bun matcher: promise matchers can stall gRPC callbacks.
async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the store operation to reject, but it fulfilled");
}

/** Same async contract runs against memory and two independent official Firestore clients. */
export function storeContract(name: string, factory: StoreFactory) {
  describe(name, () => {
    function contract(
      title: string,
      run: (fixture: StorePair & { now(): Date; setNow(ms: number): void }) => Promise<void>,
    ) {
      test(title, async () => {
        let time = Date.now();
        const now = () => new Date(time);
        const pair = await factory(now, title);
        try {
          await run({
            ...pair,
            now,
            setNow: (ms) => {
              time = ms;
            },
          });
        } finally {
          await pair.close();
        }
      }, 60_000);
    }
    for (const withAdmission of [false, true])
      contract(
        `duplicate create has exactly one winner (admission=${withAdmission})`,
        async ({ a, b, now }) => {
          const record = sessionRecord(now(), {
            keyBinding: { keyHash: "hash", subject: "subject" },
          });
          const other = { ...record, agentTokenHash: "other-agent" };
          const admission = withAdmission
            ? { clientIp: "192.0.2.1", activeMax: 2, activePerIp: 1, now: now() }
            : undefined;
          const results = await Promise.allSettled([
            a.createSession(record, admission),
            b.createSession(other, admission),
          ]);
          expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
          const winner = results.findIndex((r) => r.status === "fulfilled");
          expect((results[1 - winner] as PromiseRejectedResult).reason).toBeInstanceOf(
            SessionIdTaken,
          );
          expect(await a.getSession(record.id)).toMatchObject(winner === 0 ? record : other);
          const first = await a.getSession(record.id);
          if (!first?.keyBinding || !record.keyBinding) throw new Error("Missing fixture binding");
          first.keyBinding.subject = "mutated read";
          record.keyBinding.subject = "mutated input";
          expect((await b.getSession(record.id))?.keyBinding?.subject).toBe("subject");
        },
      );
    contract(
      "compare-and-swap permits one redemption and preserves aborted updates",
      async ({ a, b, now }) => {
        const record = sessionRecord(now(), { state: "created", browserTokenHash: null });
        await a.createSession(record);
        const results = await Promise.all(
          [a, b].map((store, i) =>
            store.updateSession(record.id, (current) =>
              current.state === "created"
                ? { ...current, state: "active", browserTokenHash: `browser-${i}` }
                : null,
            ),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results.find((result) => result !== null);
        if (!winner) throw new Error("Missing successful compare-and-swap result");
        expect(await b.getSession(record.id)).toEqual(winner);
        expect(await a.updateSession(newSessionId(), (current) => current)).toBeNull();
      },
    );
    contract(
      "concurrent appends publish one predecessor winner and a verifiable chain",
      async ({ a, b, now, trace }) => {
        const record = sessionRecord(now());
        trace?.("create:start");
        await a.createSession(record);
        trace?.("create:done; concurrent appends:start");
        const observedAppend = async (store: Store, label: string) => {
          try {
            const result = await append(store, record.id, label);
            trace?.(`append ${label}:fulfilled`);
            return result;
          } catch (error) {
            trace?.(`append ${label}:rejected ${error instanceof Error ? error.name : "unknown"}`);
            throw error;
          }
        };
        const results = await Promise.allSettled([
          observedAppend(a, "one"),
          observedAppend(b, "two"),
        ]);
        trace?.("concurrent appends:done");
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
        ).toBeInstanceOf(ChainMismatch);
        trace?.("list:start");
        const messages = await b.listMessages(record.id, 0, 200);
        trace?.("list:done; verifyChain:start");
        expect(messages).toHaveLength(1);
        expect(await verifyChain(record.id, messages)).toEqual({ ok: true });
        trace?.("verifyChain:done; getSession:start");
        expect((await a.getSession(record.id))?.lastHash).toBe(messages[0].hash);
        trace?.("getSession:done; explicit mismatch:start");
        let mismatch: unknown;
        try {
          await append(a, record.id, "bad predecessor", "wrong");
        } catch (error) {
          mismatch = error;
        }
        trace?.("explicit mismatch:settled");
        expect(mismatch).toBeInstanceOf(ChainMismatch);
        expect((mismatch as ChainMismatch).expectedPrevHash).toBe(messages[0].hash);
        trace?.("explicit mismatch:done");
      },
    );
    contract("concurrent append cap permits exactly one publication", async ({ a, b, now }) => {
      const record = sessionRecord(now());
      await a.createSession(record);
      const results = await Promise.allSettled([
        append(a, record.id, "one", "", 1),
        append(b, record.id, "two", "", 1),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toBeInstanceOf(RateLimited);
      expect(await b.listMessages(record.id, 0, 20)).toHaveLength(1);
    });
    contract("pagination returns ordered immutable copies", async ({ a, b, now }) => {
      const record = sessionRecord(now());
      await a.createSession(record);
      const first = await append(a, record.id, "one");
      const firstHash = first.hash;
      const second = await append(b, record.id, "two", firstHash);
      await append(a, record.id, "three", second.hash);
      first.ciphertext = "modified result";
      const page = await b.listMessages(record.id, 0, 1);
      expect(page[0].ciphertext).toBe("one");
      page[0].ciphertext = "modified page";
      expect((await a.listMessages(record.id, 0, 1))[0].ciphertext).toBe("one");
      expect(await a.listMessages(record.id, 1, 1)).toEqual([second]);
      expect(await b.listMessages(record.id, 3, 200)).toEqual([]);
      expect(await verifyChain(record.id, await b.listMessages(record.id, 0, 200))).toEqual({
        ok: true,
      });
    });
    contract(
      "concurrent metadata extension and append preserve both committed changes",
      async ({ a, b, now }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        const expiresAt = new Date(now().getTime() + 3_600_000).toISOString();
        await Promise.all([
          append(a, record.id),
          b.updateSession(record.id, (current) => ({ ...current, expiresAt, ttlSeconds: 3600 })),
        ]);
        expect(await a.getSession(record.id)).toMatchObject({
          expiresAt,
          ttlSeconds: 3600,
          lastSeq: 1,
        });
      },
    );
    for (const state of ["stopped", "expired"] as const)
      contract(`${state} sessions reject writes and cannot be revived`, async ({ a, b, now }) => {
        const record = sessionRecord(now(), { state });
        await a.createSession(record);
        expect(await rejection(append(a, record.id))).toBeInstanceOf(SessionNotActive);
        expect(await rejection(b.putBlob(record.id, "denied", new Uint8Array(1)))).toBeInstanceOf(
          SessionNotActive,
        );
        expect(
          await b.updateSession(record.id, (current) => ({ ...current, state: "active" })),
        ).toBeNull();
        expect(await a.listMessages(record.id, 0, 20)).toEqual([]);
        await b.waitForMessage(record.id, 0, 30_000);
      });
    contract(
      "logical expiry rejects writes without relying on background deletion",
      async ({ a, b, now, setNow }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        setNow(Date.parse(record.expiresAt));
        let hashed = false;
        expect(
          await rejection(
            a.appendMessage(
              record.id,
              { role: "agent", prevHash: "", nonce: "n", ciphertext: "c" },
              async () => {
                hashed = true;
                return "h";
              },
            ),
          ),
        ).toBeInstanceOf(SessionNotActive);
        expect(hashed).toBe(false);
        expect(await rejection(b.putBlob(record.id, "expired", new Uint8Array(1)))).toBeInstanceOf(
          SessionNotActive,
        );
        expect(
          await b.updateSession(record.id, (current) => ({
            ...current,
            expiresAt: new Date(now().getTime() + 30_000).toISOString(),
          })),
        ).toBeNull();
        await a.waitForMessage(record.id, 0, 30_000);
        expect(await a.getSession(record.id)).not.toBeNull();
      },
    );
    contract(
      "expiry is rechecked after asynchronous hashing before publication",
      async ({ a, now, setNow }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        expect(
          await rejection(
            a.appendMessage(
              record.id,
              { role: "agent", prevHash: "", nonce: "n", ciphertext: "c" },
              async (seq) => {
                setNow(Date.parse(record.expiresAt));
                return chainHash(record.id, seq, "c");
              },
            ),
          ),
        ).toBeInstanceOf(SessionNotActive);
        expect(await a.listMessages(record.id, 0, 20)).toEqual([]);
        expect(await a.getSession(record.id)).toMatchObject({ lastSeq: 0, lastHash: "" });
      },
    );
    contract(
      "global and per-IP admission are atomic; stop and expiry free capacity",
      async ({ a, b, now, setNow }) => {
        const admission = { clientIp: "192.0.2.1", activeMax: 2, activePerIp: 1, now: now() };
        const candidates = [sessionRecord(now()), sessionRecord(now())];
        const results = await Promise.allSettled([
          a.createSession(candidates[0], admission),
          b.createSession(candidates[1], admission),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
        ).toBeInstanceOf(RateLimited);
        const winner = candidates[results.findIndex((r) => r.status === "fulfilled")];
        const second = sessionRecord(now());
        await b.createSession(second, { ...admission, clientIp: "192.0.2.2" });
        expect(
          await rejection(
            a.createSession(sessionRecord(now()), { ...admission, clientIp: "192.0.2.3" }),
          ),
        ).toBeInstanceOf(RateLimited);
        await a.updateSession(winner.id, (current) => ({ ...current, state: "stopped" }));
        await b.createSession(sessionRecord(now()), admission);
        setNow(Date.parse(second.expiresAt));
        await a.createSession(sessionRecord(now()), { ...admission, now: now() });
      },
    );
    contract("two IPs racing for one global slot admit exactly one", async ({ a, b, now }) => {
      const results = await Promise.allSettled(
        [a, b].map((store, i) =>
          store.createSession(sessionRecord(now()), {
            clientIp: `192.0.2.${i}`,
            activeMax: 1,
            activePerIp: 1,
            now: now(),
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toBeInstanceOf(RateLimited);
    });
    contract(
      "extension retains admission beyond original expiry",
      async ({ a, b, now, setNow }) => {
        const record = sessionRecord(now());
        const admission = { clientIp: "192.0.2.1", activeMax: 1, activePerIp: 1, now: now() };
        await a.createSession(record, admission);
        const extended = new Date(now().getTime() + 3_600_000).toISOString();
        await b.updateSession(record.id, (current) => ({
          ...current,
          expiresAt: extended,
          ttlSeconds: 3600,
        }));
        setNow(Date.parse(record.expiresAt));
        expect(
          await rejection(a.createSession(sessionRecord(now()), { ...admission, now: now() })),
        ).toBeInstanceOf(RateLimited);
        setNow(Date.parse(extended));
        await b.createSession(sessionRecord(now()), { ...admission, now: now() });
      },
    );
    contract(
      "blob budgets reserve atomically and bytes cannot be mutated externally",
      async ({ a, b, now }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        const bytes = new Uint8Array([1, 2, 3]);
        const results = await Promise.allSettled([
          a.putBlob(record.id, "one", bytes, 5),
          b.putBlob(record.id, "two", bytes, 5),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
        ).toBeInstanceOf(RateLimited);
        const winner = results[0].status === "fulfilled" ? "one" : "two";
        bytes.fill(9);
        const stored = await b.getBlob(record.id, winner);
        expect(stored).toEqual(new Uint8Array([1, 2, 3]));
        stored?.fill(8);
        expect(await a.getBlob(record.id, winner)).toEqual(new Uint8Array([1, 2, 3]));
        await a.putBlob(record.id, "rest", new Uint8Array(2), 5);
        expect((await b.getSession(record.id))?.blobBytes).toBe(5);
        expect(
          await rejection(b.putBlob(record.id, "overflow", new Uint8Array(1), 5)),
        ).toBeInstanceOf(RateLimited);
        expect(await a.getBlob(record.id, "overflow")).toBeNull();
      },
    );
    contract(
      "duplicate blob IDs cannot overwrite and failed uploads retain reservations",
      async ({ a, b, now }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        await a.putBlob(record.id, "same", new Uint8Array([1, 2]), 4);
        const duplicateError = await rejection(
          b.putBlob(record.id, "same", new Uint8Array([3, 4]), 4),
        );
        expect(() => {
          throw duplicateError;
        }).toThrow();
        expect(await b.getBlob(record.id, "same")).toEqual(new Uint8Array([1, 2]));
        expect((await a.getSession(record.id))?.blobBytes).toBe(4);
        expect(
          await rejection(a.putBlob(record.id, "excess", new Uint8Array(1), 4)),
        ).toBeInstanceOf(RateLimited);
      },
    );
    contract(
      "waiters observe new heads, preexisting heads and stop across instances",
      async ({ a, b, now }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        const waiting = a.waitForMessage(record.id, 0, 30_000);
        await append(b, record.id);
        await waiting;
        await a.waitForMessage(record.id, 0, 30_000);
        const stopped = b.waitForMessage(record.id, 1, 30_000);
        await a.updateSession(record.id, (current) => ({ ...current, state: "stopped" }));
        await stopped;
      },
    );
    contract(
      "wait timeout and logical expiry resolve without a message",
      async ({ a, now, setNow }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        const start = performance.now();
        await a.waitForMessage(record.id, 0, 30);
        expect(performance.now() - start).toBeGreaterThanOrEqual(20);
        const expired = {
          ...sessionRecord(now()),
          expiresAt: new Date(now().getTime() + 100).toISOString(),
        };
        await a.createSession(expired);
        const waiting = a.waitForMessage(expired.id, 0, 30_000);
        setNow(Date.parse(expired.expiresAt));
        await waiting;
      },
    );
    contract(
      "request cancellation releases a waiting listener without touching the session",
      async ({ a, now }) => {
        const record = sessionRecord(now());
        await a.createSession(record);
        const controller = new AbortController();
        const waiting = a.waitForMessage(record.id, 0, 30_000, controller.signal);
        controller.abort();
        await waiting;
        await a.waitForMessage(record.id, 0, 30_000, controller.signal);
        expect(await a.getSession(record.id)).toMatchObject(record);
      },
    );
  });
}
