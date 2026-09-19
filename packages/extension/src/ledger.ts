import type { LedgerEntry } from "@remote-tab/client";
import { UUID_V4_RE } from "@remote-tab/protocol";
import { makeLedgerZip, screenshots } from "./archive";
import { record } from "./chrome";
import { CONTROL_EVENTS_NOTE, type ExtensionLedger } from "./control-events";
import { GifEncoder, quantize } from "./gif";
import { loadLedger } from "./ledger-data";
import { actionSummary } from "./summary";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status");
const zipButton = element<HTMLButtonElement>("download-zip");
const gifButton = element<HTMLButtonElement>("render-gif");
const exportStatus = element("export-status");
const urls = new Set<string>();
const jobId = location.hash.slice(1);
let ledger: ExtensionLedger | undefined;
let gifUrl: string | undefined;
function blobUrl(bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  urls.add(url);
  return url;
}
function revoke(url: string) {
  URL.revokeObjectURL(url);
  urls.delete(url);
}
function releaseJob() {
  if (!UUID_V4_RE.test(jobId)) return;
  try {
    void chrome.runtime.sendMessage({ action: "ledger-release", jobId }).catch(() => {});
  } catch {
    // The worker or extension context may already be unavailable during unload.
  }
}
window.addEventListener("pagehide", () => {
  releaseJob();
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
});
function textNode<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function details(label: string, value: unknown) {
  const node = document.createElement("details");
  node.append(
    textNode("summary", label),
    textNode("pre", JSON.stringify(value, null, 2) ?? "null"),
  );
  return node;
}
function pngSize(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  )
    throw new Error("A screenshot is not a valid PNG. Export was stopped.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32_000_000)
    throw new Error("A screenshot exceeds the 32-million-pixel image limit. Export was stopped.");
  return { width, height };
}
function appendResult(article: HTMLElement, entry?: LedgerEntry) {
  if (!entry) {
    article.append(textNode("p", "Incomplete — no result recorded.", "outcome incomplete"));
    return;
  }
  const body = record(entry.envelope.body) ? entry.envelope.body : {};
  if (body.ok === false) {
    const error = record(body.error) ? body.error : {};
    article.append(
      textNode(
        "p",
        `Failed: ${String(error.message ?? error.code ?? "Unknown error")}`,
        "outcome error",
      ),
    );
  } else article.append(textNode("p", "Completed", "outcome"));
  if ("result" in body) article.append(details("Result details", body.result));
}
function showLedger(history: ExtensionLedger) {
  const timeline = element("timeline");
  const results = new Map(
    history.entries
      .filter((entry) => entry.envelope.kind === "result")
      .map((entry) => [entry.envelope.id, entry]),
  );
  const commandIds = new Set(
    history.entries
      .filter((entry) => entry.envelope.kind === "command")
      .map((entry) => entry.envelope.id),
  );
  const frameMap = new Map<number, ReturnType<typeof screenshots>>();
  for (const frame of screenshots(history)) {
    const list = frameMap.get(frame.seq) ?? [];
    list.push(frame);
    frameMap.set(frame.seq, list);
  }
  const fragment = document.createDocumentFragment();
  let commands = 0;
  for (const entry of history.entries) {
    const { kind, body: rawBody } = entry.envelope;
    if (
      kind === "result" &&
      commandIds.has(entry.envelope.id) &&
      results.get(entry.envelope.id) === entry
    )
      continue;
    const body = record(rawBody) ? rawBody : {};
    const article = document.createElement("article");
    article.className = "entry";
    const title =
      kind === "command"
        ? actionSummary(String(body.tool ?? ""))
        : kind === "hello"
          ? "Sharing consent recorded"
          : kind === "handoff"
            ? "Agent requested your help"
            : kind === "handoff_done"
              ? "Human handoff completed"
              : kind === "stop"
                ? "Sharing stopped"
                : "Additional or unmatched result";
    article.append(textNode("h3", `${entry.message.seq}. ${title}`));
    article.append(
      textNode("p", `Sequence ${entry.message.seq} · ${entry.message.created_at}`, "meta"),
    );
    let matched: LedgerEntry | undefined;
    if (kind === "command") {
      commands++;
      article.append(textNode("code", String(body.tool ?? "Unknown command")));
      article.append(details("Command details", body));
      matched = results.get(entry.envelope.id);
      appendResult(article, matched);
      if (matched) article.append(textNode("p", `Result sequence ${matched.message.seq}`, "meta"));
    } else if (kind === "result") appendResult(article, entry);
    else if (kind === "hello") article.append(details("Consent details", body));
    else if (kind === "handoff") {
      article.append(textNode("p", String(body.message ?? "")));
      if (
        !history.entries.some(
          (candidate) =>
            candidate.envelope.kind === "handoff_done" &&
            candidate.envelope.id === entry.envelope.id,
        )
      )
        article.append(
          textNode("p", "Incomplete — human Done was not recorded.", "outcome incomplete"),
        );
    }
    for (const frame of frameMap.get(matched?.message.seq ?? entry.message.seq) ?? []) {
      try {
        pngSize(frame.bytes);
      } catch (error) {
        article.append(
          textNode(
            "p",
            `Screenshot preview unavailable: ${error instanceof Error ? error.message : "invalid PNG"} The original bytes remain in the ZIP.`,
            "error",
          ),
        );
        continue;
      }
      const img = document.createElement("img");
      img.src = blobUrl(frame.bytes, "image/png");
      img.alt = `Screenshot recorded at sequence ${frame.seq}`;
      img.loading = "lazy";
      article.append(img);
    }
    fragment.append(article);
  }
  if (history.controlEvents?.length) {
    const controls = document.createElement("section");
    controls.id = "local-human-controls";
    controls.append(textNode("h2", "Local human controls"), textNode("p", CONTROL_EVENTS_NOTE));
    for (const event of history.controlEvents) {
      const article = document.createElement("article");
      article.className = "entry";
      article.append(
        textNode("h3", event.action === "pause" ? "Human paused sharing" : "Human resumed sharing"),
        textNode("p", event.timestamp, "meta"),
      );
      controls.append(article);
    }
    fragment.append(controls);
  }
  timeline.replaceChildren(fragment);
  element("empty").hidden = commands !== 0;
  element("session").textContent =
    `Session ${history.sessionId} · Last sequence ${history.status.last_seq}`;
  const active = history.status.state !== "stopped" && history.status.state !== "expired";
  status.textContent = `Verified ${active ? "active-session snapshot" : `${history.status.state} session history`} · ${history.entries.length} entries. ${active ? "Sharing may continue; this page does not update automatically." : "This history is ready to save."}`;
  status.dataset.state = "verified";
}
zipButton.onclick = () => {
  if (!ledger) return;
  try {
    const url = blobUrl(makeLedgerZip(ledger), "application/zip");
    const link = document.createElement("a");
    link.href = url;
    link.download = `${ledger.sessionId}-ledger.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => revoke(url), 60_000);
    exportStatus.textContent =
      "ZIP download started. Keep it private: it contains your session history.";
  } catch (error) {
    exportStatus.textContent = error instanceof Error ? error.message : "ZIP export failed.";
  }
};
gifButton.onclick = async () => {
  if (!ledger || (ledger.status.state !== "stopped" && ledger.status.state !== "expired")) return;
  gifButton.disabled = true;
  exportStatus.textContent = "Rendering screenshots locally…";
  try {
    const frames = screenshots(ledger);
    if (!frames.length) throw new Error("This snapshot has no screenshots to animate.");
    if (frames.length > 300)
      throw new Error(
        "GIF export supports at most 300 screenshots. Download the ZIP for the complete history.",
      );
    const width = 640;
    const height = 360;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser could not create a GIF canvas.");
    const encoder = new GifEncoder(width, height, ledger.sessionId);
    for (const frame of frames) {
      const size = pngSize(frame.bytes);
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(frame.bytes)], { type: "image/png" }),
      );
      try {
        if (bitmap.width !== size.width || bitmap.height !== size.height)
          throw new Error("Screenshot dimensions could not be verified.");
        context.fillStyle = "#111827";
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = false;
        const scale = Math.min(width / bitmap.width, height / bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        context.drawImage(bitmap, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
        encoder.addFrame(quantize(context.getImageData(0, 0, width, height).data));
      } finally {
        bitmap.close();
      }
    }
    const next = blobUrl(encoder.finish(), "image/gif");
    if (gifUrl) revoke(gifUrl);
    gifUrl = next;
    element<HTMLImageElement>("gif-player").src = next;
    const link = element<HTMLAnchorElement>("download-gif");
    link.href = next;
    link.download = `${ledger.sessionId}.gif`;
    element("gif-preview").hidden = false;
    exportStatus.textContent = `Rendered ${frames.length} screenshots at one frame per second. All rendering stayed in this page.`;
  } catch (error) {
    exportStatus.textContent = error instanceof Error ? error.message : "GIF export failed.";
  } finally {
    gifButton.disabled = false;
  }
};
async function start() {
  try {
    if (!jobId) throw new Error("This ledger page has no history job. Open it from Remote Tab.");
    const verified = await loadLedger(jobId, (message) => chrome.runtime.sendMessage(message));
    showLedger(verified);
    ledger = verified;
    zipButton.disabled = false;
    const final = verified.status.state === "stopped" || verified.status.state === "expired";
    gifButton.disabled = !final;
    if (!final) exportStatus.textContent = "Stop sharing to render the final replay.";
  } catch (error) {
    releaseJob();
    status.dataset.state = "error";
    status.textContent = `History unavailable: ${error instanceof Error ? error.message : "verification failed"}`;
  }
}
void start();
