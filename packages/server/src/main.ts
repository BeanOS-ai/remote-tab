// Entrypoint. Configuration by environment only; no deployment specifics here.
//   REMOTE_TAB_API_KEYS   platform:key[,platform:key]   (required)
//   REMOTE_TAB_STORE      memory | gcs                   (default memory)
//   REMOTE_TAB_GCS_BUCKET bucket name                    (gcs only)
//   PORT                                                (default 8080)
import { createApp, parseApiKeys } from "./app";
import { GcsStore } from "./gcs-store";
import { MemoryStore } from "./memory-store";

const apiKeys = parseApiKeys(process.env.REMOTE_TAB_API_KEYS);
if (apiKeys.size === 0) throw new Error("REMOTE_TAB_API_KEYS is required");

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

const app = createApp({ store, apiKeys });
const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
console.log(
  `remote-tab server listening on :${port} (store=${process.env.REMOTE_TAB_STORE ?? "memory"})`,
);
