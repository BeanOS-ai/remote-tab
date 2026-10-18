import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { MemoryStore } from "../../server/src/memory-store";
import { execute, parseArgs } from "./index";

test("CLI creates without a platform key, then uses saved role credentials without extra key state", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-tab-anonymous-cli-"));
  const statePath = join(root, "state.json");
  const originalFetch = globalThis.fetch;
  const app = createApp({ store: new MemoryStore() });
  const headers: (string | null)[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    headers.push(request.headers.get("authorization"));
    return app.fetch(request);
  }) as typeof fetch;
  try {
    const created = await execute(parseArgs(["create", "--state", statePath]), {
      REMOTE_TAB_SERVER_URL: "https://remote-tab.test",
    });
    expect(created).toMatchObject({ state: statePath, tier: "anonymous" });
    expect(headers).toEqual([null]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(Object.keys(saved).sort()).toEqual([
      "agentToken",
      "secret",
      "serverUrl",
      "sessionId",
      "tier",
      "v",
    ]);
    expect(saved.tier).toBe("anonymous");
    expect(await execute(parseArgs(["status", "--state", statePath]), {})).toMatchObject({
      state: "created",
    });
    expect(headers.slice(1).every((header) => header === `Bearer ${saved.agentToken}`)).toBe(true);
    expect(await readFile(statePath, "utf8")).toBe(`${JSON.stringify(saved)}\n`);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI supports older servers without inferring a tier from the supplied key", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-tab-legacy-cli-"));
  const statePath = join(root, "state.json");
  const originalFetch = globalThis.fetch;
  const app = createApp({ store: new MemoryStore() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    // Model an older relay accepting an API key but returning no tier metadata.
    if (new URL(request.url).pathname === "/v1/sessions") {
      expect(request.headers.get("authorization")).toBe("Bearer legacy-key");
      request.headers.delete("authorization");
      const response = await app.fetch(request);
      const { tier: _tier, ...body } = await response.json();
      return Response.json(body, { status: response.status });
    }
    return app.fetch(request);
  }) as typeof fetch;
  try {
    const created = await execute(parseArgs(["create", "--state", statePath]), {
      REMOTE_TAB_SERVER_URL: "https://remote-tab.test",
      REMOTE_TAB_API_KEY: "legacy-key",
    });
    expect(created).not.toHaveProperty("tier");
    const saved = await readFile(statePath, "utf8");
    expect(JSON.parse(saved)).not.toHaveProperty("tier");
    expect(saved).not.toContain("legacy-key");
    expect(await execute(parseArgs(["status", "--state", statePath]), {})).toMatchObject({
      state: "created",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
