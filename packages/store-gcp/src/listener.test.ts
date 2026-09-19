import { expect, test } from "bun:test";
import type { Firestore } from "@google-cloud/firestore";
import { GcpStore } from "./firestore-store";

const id = "a".repeat(32);
type Snapshot = { exists: boolean; data(): { lastSeq: number; state: string; expiresAt: string } };

/** Simulates listener delivery and elapsed time, without a network or real sleeps. */
async function listening(run: (listener: ReturnType<typeof fixture>) => Promise<void>) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const f = fixture();
  globalThis.setTimeout = ((callback: () => void, ms = 0) => {
    const timer = ++f.nextTimer;
    f.timers.set(timer, { at: f.time + ms, callback });
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: number) => {
    f.timers.delete(timer);
  }) as unknown as typeof clearTimeout;
  try {
    await run(f);
    expect(f.timers.size).toBe(0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

function fixture() {
  let onNext: ((snapshot: Snapshot) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const f = {
    time: 1000,
    nextTimer: 0,
    subscriptions: 0,
    unsubscriptions: 0,
    timers: new Map<number, { at: number; callback(): void }>(),
    initial: undefined as Snapshot | undefined,
    emit(lastSeq = 0, expires?: number, state = "active"): void {
      onNext?.({
        exists: true,
        data: () => ({
          lastSeq,
          state,
          expiresAt: new Date(expires ?? f.time + 10_000).toISOString(),
        }),
      });
    },
    fail(error: Error) {
      onError?.(error);
    },
    advance(ms: number) {
      const target = f.time + ms;
      while (true) {
        const due = [...f.timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        f.time = due[1].at;
        f.timers.delete(due[0]);
        due[1].callback();
      }
      f.time = target;
    },
    store: undefined as unknown as GcpStore,
  };
  const firestore = {
    collection: () => ({
      doc: () => ({
        onSnapshot: (next: (snapshot: Snapshot) => void, error: (error: Error) => void) => {
          f.subscriptions++;
          onNext = next;
          onError = error;
          if (f.initial) next(f.initial);
          return () => {
            f.unsubscriptions++;
          };
        },
      }),
    }),
  } as unknown as Firestore;
  f.store = new GcpStore({
    firestore,
    now: () => new Date(f.time),
    blobs: { put: async () => {}, get: async () => null },
  });
  return f;
}

test("a stalled listener resolves at the 25-second bound and unsubscribes", async () => {
  await listening(async (f) => {
    let done = false;
    const pending = f.store.waitForMessage(id, 0, 60_000).then(() => {
      done = true;
    });
    f.advance(24_999);
    await Promise.resolve();
    expect(done).toBe(false);
    f.advance(1);
    await pending;
    expect(f.unsubscriptions).toBe(1);
  });
});

test("request abort releases the subscription and both timers; pre-abort never subscribes", async () => {
  await listening(async (f) => {
    const controller = new AbortController();
    const pending = f.store.waitForMessage(id, 0, 20_000, controller.signal);
    f.emit();
    expect(f.timers.size).toBe(2);
    controller.abort();
    await pending;
    expect(f.unsubscriptions).toBe(1);
    await f.store.waitForMessage(id, 0, 20_000, controller.signal);
    expect(f.subscriptions).toBe(1);
    f.advance(30_000);
    expect(f.unsubscriptions).toBe(1);
  });
});

test("listener errors reject and unsubscribe without waiting for expiry", async () => {
  await listening(async (f) => {
    const error = new Error("test listener failure");
    const pending = f.store.waitForMessage(id, 0, 20_000);
    f.emit();
    f.fail(error);
    await expect(pending).rejects.toBe(error);
    expect(f.unsubscriptions).toBe(1);
  });
});

test("Extend replaces the previous expiry deadline and expiry closes the listener", async () => {
  await listening(async (f) => {
    let done = false;
    const pending = f.store.waitForMessage(id, 0, 20_000).then(() => {
      done = true;
    });
    f.emit(0, 2000);
    f.advance(500);
    f.emit(0, 4000);
    f.advance(500);
    await Promise.resolve();
    expect(done).toBe(false);
    expect(f.unsubscriptions).toBe(0);
    expect(f.timers.size).toBe(2);
    f.advance(2000);
    await pending;
    expect(f.unsubscriptions).toBe(1);
  });
});

test("initial snapshots close the registration race even with synchronous delivery", async () => {
  for (const exists of [true, false]) {
    await listening(async (f) => {
      f.initial = {
        exists,
        data: () => ({ lastSeq: 1, state: "active", expiresAt: new Date(30_000).toISOString() }),
      };
      await f.store.waitForMessage(id, 0, 20_000);
      expect(f.subscriptions).toBe(1);
      expect(f.unsubscriptions).toBe(1);
    });
  }
});

test("a terminal snapshot clears expiry and ignores subsequent late delivery", async () => {
  await listening(async (f) => {
    const pending = f.store.waitForMessage(id, 0, 20_000);
    f.emit();
    f.emit(0, 30_000, "stopped");
    await pending;
    f.emit(0, 40_000);
    f.fail(new Error("late delivery"));
    expect(f.unsubscriptions).toBe(1);
  });
});
