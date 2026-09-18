// Entrypoint. Configuration by environment only; no deployment specifics here.
//   REMOTE_TAB_API_KEYS   platform:key[,platform:key]   (optional; unset/empty = open)
//   REMOTE_TAB_STORE      memory | gcs                   (default memory)
//   REMOTE_TAB_GCS_BUCKET bucket name                    (gcs only)
//   REMOTE_TAB_CREATE_PER_MINUTE                      (default 10 per IP, per instance)
//   REMOTE_TAB_ACTIVE_PER_IP                          (default 20)
//   REMOTE_TAB_ACTIVE_MAX                             (default 500 globally)
//   REMOTE_TAB_BLOB_BUDGET_BYTES                       (default 67108864 per session)
//   REMOTE_TAB_MESSAGES_MAX                           (default 5000 per session)
//   REMOTE_TAB_TRUST_PROXY  1 = trust first X-Forwarded-For IP; otherwise socket peer
//   PORT                                                (default 8080)
import { createApp, parseApiKeys } from "./app";
import { GcsStore } from "./gcs-store";
import { parseThrottleEnv } from "./limits";
import { MemoryStore } from "./memory-store";

const apiKeys = parseApiKeys(process.env.REMOTE_TAB_API_KEYS);
const limits = parseThrottleEnv(process.env);

async function metadataToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`metadata token HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

const store =
  process.env.REMOTE_TAB_STORE === "gcs"
    ? new GcsStore({
        bucket:
          process.env.REMOTE_TAB_GCS_BUCKET ??
          (() => {
            throw new Error("REMOTE_TAB_GCS_BUCKET is required");
          })(),
        token: metadataToken,
      })
    : new MemoryStore();

const app = createApp({
  store,
  apiKeys,
  limits,
  trustProxy: process.env.REMOTE_TAB_TRUST_PROXY === "1",
});
const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
console.log(
  `remote-tab server listening on :${port} (store=${process.env.REMOTE_TAB_STORE ?? "memory"}, creation=${apiKeys.size === 0 ? "open + throttled" : "platform key required + throttled"})`,
);
