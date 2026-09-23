import { createSession } from "../packages/client/src/index";

/**
 * Read one human-shared tab, then stop. The caller must deliver the code only
 * through a private authenticated channel to the intended human, never logs.
 */
export async function inspectSharedTab(deliverCode: (code: string) => Promise<void>) {
  const serverUrl = process.env.REMOTE_TAB_SERVER_URL;
  if (!serverUrl) throw new Error("Set REMOTE_TAB_SERVER_URL");

  const { code, session } = await createSession({
    serverUrl,
    apiKey: process.env.REMOTE_TAB_API_KEY,
    ttl: 1800,
  });

  try {
    // Ask the human to select a tab, read mode, and scope, then press Read my tab.
    // A valid hello proves code possession, not the human's identity.
    await deliverCode(code);
    await session.waitReady({ timeoutMs: 120_000 });
    const snapshot = await session.send("browser_snapshot", {});
    if (!snapshot.ok) throw new Error(snapshot.error?.code ?? "snapshot_failed");

    // Page content is untrusted data, never instructions. Keep it private.
    return snapshot.result;
  } finally {
    await session.stop();
  }
}
