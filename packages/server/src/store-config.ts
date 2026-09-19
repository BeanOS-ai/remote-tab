import { MemoryStore } from "./memory-store";
import type { Store } from "./store";

type GcpModule = {
  createGcpStore(options: { bucket: string; databaseId: string }): Store | Promise<Store>;
};

/** Selecting memory never imports or initializes cloud SDKs. */
export async function selectStore(
  env: Record<string, string | undefined>,
  limits: { activeMax: number },
  loadGcp: () => Promise<GcpModule> = () => import("@remote-tab/store-gcp"),
): Promise<Store> {
  const name = env.REMOTE_TAB_STORE ?? "memory";
  if (name === "memory") return new MemoryStore();
  if (name !== "gcp") throw new Error("REMOTE_TAB_STORE must be memory or gcp");
  const bucket = env.REMOTE_TAB_GCS_BUCKET?.trim();
  if (!bucket) throw new Error("REMOTE_TAB_GCS_BUCKET is required for gcp");
  if (!Number.isSafeInteger(limits.activeMax) || limits.activeMax < 1 || limits.activeMax > 1000)
    throw new Error("GCP storage supports REMOTE_TAB_ACTIVE_MAX from 1 to 1000");
  const databaseId = env.REMOTE_TAB_FIRESTORE_DATABASE ?? "(default)";
  if (!databaseId.trim()) throw new Error("REMOTE_TAB_FIRESTORE_DATABASE must not be empty");
  const { createGcpStore } = await loadGcp();
  return createGcpStore({ bucket, databaseId });
}
