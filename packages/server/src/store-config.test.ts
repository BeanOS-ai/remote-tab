import { expect, test } from "bun:test";
import { MemoryStore } from "./memory-store";
import { selectStore } from "./store-config";

test("memory default and explicit memory never initialize the GCP adapter", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    throw new Error("cloud unavailable");
  };
  for (const env of [{}, { REMOTE_TAB_STORE: "memory" }])
    expect(await selectStore(env, { activeMax: 500 }, load)).toBeInstanceOf(MemoryStore);
  expect(calls).toBe(0);
});

test("GCP selection forwards generic bucket and database without credentials", async () => {
  const calls: unknown[] = [];
  const result = new MemoryStore();
  const load = async () => ({
    createGcpStore: (options: unknown) => {
      calls.push(options);
      return result;
    },
  });
  const env = { REMOTE_TAB_STORE: "gcp", REMOTE_TAB_GCS_BUCKET: "example-ciphertext" };
  expect(await selectStore(env, { activeMax: 500 }, load)).toBe(result);
  await selectStore(
    { ...env, REMOTE_TAB_FIRESTORE_DATABASE: "custom-database" },
    { activeMax: 1000 },
    load,
  );
  expect(calls).toEqual([
    { bucket: "example-ciphertext", databaseId: "(default)" },
    { bucket: "example-ciphertext", databaseId: "custom-database" },
  ]);
});

test("invalid and retired selectors, missing bucket, or oversized admission fail before loading", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return { createGcpStore: () => new MemoryStore() };
  };
  for (const selector of ["gcs", "unknown", ""])
    await expect(
      selectStore({ REMOTE_TAB_STORE: selector }, { activeMax: 500 }, load),
    ).rejects.toThrow("memory or gcp");
  await expect(selectStore({ REMOTE_TAB_STORE: "gcp" }, { activeMax: 500 }, load)).rejects.toThrow(
    "REMOTE_TAB_GCS_BUCKET",
  );
  const env = { REMOTE_TAB_STORE: "gcp", REMOTE_TAB_GCS_BUCKET: "example-ciphertext" };
  for (const activeMax of [0, 1001, Number.NaN])
    await expect(selectStore(env, { activeMax }, load)).rejects.toThrow("from 1 to 1000");
  await expect(
    selectStore({ ...env, REMOTE_TAB_FIRESTORE_DATABASE: " " }, { activeMax: 500 }, load),
  ).rejects.toThrow("must not be empty");
  expect(calls).toBe(0);
});
