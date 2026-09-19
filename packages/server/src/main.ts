// Entrypoint. See README for generic environment configuration.
import { createApp } from "./app";
import { serverPolicy } from "./config";
import { GcsStore } from "./gcs-store";
import { MemoryStore } from "./memory-store";

const policy = serverPolicy(process.env);

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
  ...policy,
});
const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
console.log(
  `remote-tab server listening on :${port} (store=${process.env.REMOTE_TAB_STORE ?? "memory"}, access=${policy.anonymousQps === 0 ? "keys required" : "anonymous + keyed"})`,
);
