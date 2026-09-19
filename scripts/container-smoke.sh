#!/usr/bin/env bash
# Offline runtime checks for the image built by packages/server/Dockerfile.
set -euo pipefail
image=${1:?Usage: bash scripts/container-smoke.sh IMAGE}
containers=()
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

memory=$(docker run -d --network none "$image")
containers+=("$memory")
docker exec "$memory" bun -e '
  import assert from "node:assert/strict";
  assert.equal(Bun.version, "1.4.2");
  assert.notEqual(process.getuid(), 0);
  const origin = "http://127.0.0.1:8080";
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const docs = await fetch(`${origin}/docs`);
      assert.equal(docs.status, 200);
      assert.ok((await docs.text()).includes("remote-tab"));
      ready = true;
      break;
    } catch { await Bun.sleep(100); }
  }
  assert.equal(ready, true, "Memory server failed to start");
  const created = await fetch(`${origin}/v1/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "0123456789abcdef0123456789abcdef", ttl_seconds: 60 }),
  });
  assert.equal(created.status, 201);
  const session = await created.json();
  const headers = { authorization: `Bearer ${session.agent_token}` };
  const status = await fetch(`${origin}/v1/sessions/${session.id}`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).state, "created");
  const stopped = await fetch(`${origin}/v1/sessions/${session.id}/stop`, { method: "POST", headers });
  assert.equal(stopped.status, 200);
  console.log("PASS: non-root Bun 1.4.2, embedded docs, memory create/status/stop");
'

# Loading official SDKs and constructing ADC clients must work offline; no GCP
# data route is exercised and no credentials or project configuration are needed.
gcp=$(docker run -d --network none -e REMOTE_TAB_STORE=gcp -e REMOTE_TAB_GCS_BUCKET=container-smoke-unused "$image")
containers+=("$gcp")
docker exec "$gcp" bun -e '
  import assert from "node:assert/strict";
  const { createGcpStore } = await import("@remote-tab/store-gcp");
  assert.equal(typeof createGcpStore, "function");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:8080/docs");
      assert.equal(response.status, 200);
      console.log("PASS: optional GCP workspace and official SDKs load; server starts offline");
      process.exit(0);
    } catch { await Bun.sleep(100); }
  }
  throw new Error("GCP server failed to start");
'

invalid=$(docker create --network none -e REMOTE_TAB_STORE=gcp "$image")
containers+=("$invalid")
docker start "$invalid" >/dev/null
exit_code=$(docker wait "$invalid")
test "$exit_code" -ne 0
docker logs "$invalid" 2>&1 | grep -q 'REMOTE_TAB_GCS_BUCKET is required for gcp'
echo 'PASS: GCP configuration errors fail startup'
