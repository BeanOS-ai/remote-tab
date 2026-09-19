// Entrypoint. See README for generic environment configuration.
import { createApp } from "./app";
import { serverPolicy } from "./config";
import { selectStore } from "./store-config";

const policy = serverPolicy(process.env);
const store = await selectStore(process.env, policy.limits);

const app = createApp({
  store,
  ...policy,
});
const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 60 });
console.log(
  `remote-tab server listening on :${port} (store=${process.env.REMOTE_TAB_STORE ?? "memory"}, access=${policy.anonymousQps === 0 ? "keys required" : "anonymous + keyed"})`,
);
