import { type Cdp, DriverError } from "./driver";

export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type MaskImage = (
  png: Uint8Array,
  clip: ScreenshotClip,
  masks: MaskRect[],
) => Promise<Uint8Array>;
interface ScanState {
  frame: string;
  document: string;
  masks: MaskRect[];
  sensitiveIds: Set<number>;
  hasSensitive: boolean;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const encoder = new TextEncoder();
const REDACTED = "[redacted]";
const MAX_VALUES = 512;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_NODES = 100000;
const FAILURE_MESSAGES = {
  inspection_failed: "The browser could not provide a privacy inspection snapshot",
  invalid_snapshot: "The browser returned incomplete or invalid privacy inspection data",
  node_limit: "Privacy inspection exceeds the 100000-node page limit",
  invalid_geometry: "The browser returned invalid element geometry for privacy masking",
  secret_limit: "Protected values exceed the per-share privacy memory limits",
  result_depth: "The result exceeds the privacy sanitizer nesting limit",
  invalid_viewport: "The browser could not provide valid screenshot viewport geometry",
  empty_clip: "The requested screenshot region is outside the visible viewport",
  document_changed: "The document changed during screenshot capture",
  viewport_changed: "The viewport changed during screenshot capture",
  masks_changed: "Protected field or embedded-frame geometry changed during screenshot capture",
  image_masking_failed: "The screenshot could not be decoded or masked safely",
  image_limit: "The screenshot exceeds the privacy image size limits",
  image_scale: "Screenshot dimensions do not match the inspected viewport",
} as const;
type PrivacyFailureReason = keyof typeof FAILURE_MESSAGES;
const failures = new WeakMap<Error, PrivacyFailureReason>();
const deny = (reason: PrivacyFailureReason = "invalid_snapshot") => {
  const error = new DriverError(
    "privacy_denied",
    `Privacy protection: ${FAILURE_MESSAGES[reason]}`,
  );
  failures.set(error, reason);
  return error;
};
/** Only extension-owned categories may leave the guard; CDP errors can contain secrets. */
export function privacyFailure(error: unknown): { reason: string; message: string } {
  const reason = error instanceof Error ? failures.get(error) : undefined;
  return {
    reason: reason ?? "inspection_failed",
    message: FAILURE_MESSAGES[reason ?? "inspection_failed"],
  };
}
function safeFailure(error: unknown, fallback: PrivacyFailureReason): DriverError {
  return error instanceof DriverError && failures.has(error) ? error : deny(fallback);
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function sparse(data: unknown): Map<number, unknown> {
  const value = record(data);
  const values = array(value.value);
  return new Map(array(value.index).map((index, i) => [Number(index), values[i]]));
}
function sensitive(attributes: Map<string, string>): boolean {
  return (
    attributes.get("type")?.toLowerCase() === "password" ||
    (attributes.get("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token === "one-time-code" || token.startsWith("cc-"))
  );
}
function rectangle(value: unknown): MaskRect {
  const bounds = array(value);
  if (
    bounds.length !== 4 ||
    !bounds.every(finite) ||
    Number(bounds[2]) < 0 ||
    Number(bounds[3]) < 0
  )
    throw deny("invalid_geometry");
  return {
    x: Number(bounds[0]),
    y: Number(bounds[1]),
    width: Number(bounds[2]),
    height: Number(bounds[3]),
  };
}
function intersect(a: MaskRect, b: MaskRect): MaskRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** Runs only in the extension worker. Original pixels never leave this function. */
export const maskPng: MaskImage = async (png, clip, masks) => {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined")
    throw deny("image_masking_failed");
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32_000_000)
      throw deny("image_limit");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw deny("image_masking_failed");
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = "#000000";
    const sx = bitmap.width / clip.width;
    const sy = bitmap.height / clip.height;
    if (Math.abs(sx - sy) > Math.max(sx, sy) * 0.02) throw deny("image_scale");
    for (const mask of masks) {
      // Outward rounding + padding also covers borders and antialiased glyph edges.
      const padded = {
        x: mask.x - 3,
        y: mask.y - 3,
        width: mask.width + 6,
        height: mask.height + 6,
      };
      const box = intersect(padded, clip);
      if (!box.width || !box.height) continue;
      const x = Math.floor((box.x - clip.x) * sx);
      const y = Math.floor((box.y - clip.y) * sy);
      context.fillRect(
        x,
        y,
        Math.ceil((box.x + box.width - clip.x) * sx) - x,
        Math.ceil((box.y + box.height - clip.y) * sy) - y,
      );
    }
    const output = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
    if (output.byteLength > 4 * 1024 * 1024) throw deny("image_limit");
    return output;
  } finally {
    bitmap.close();
  }
};

/** Per-share volatile privacy state. It is never serialized or sent to transport. */
export class PrivacyGuard {
  private state: ScanState | undefined;
  private values = new Set<string>();
  private variants = new Set<string>();
  private bytes = 0;
  private replacement: RegExp | undefined;
  private failed = false;
  private protectedContentSeen = false;
  private readonly maskImage: MaskImage;
  constructor(
    private readonly cdp: Cdp,
    options: { maskImage?: MaskImage } = {},
  ) {
    this.maskImage = options.maskImage ?? maskPng;
  }
  get hasSensitive(): boolean {
    // A page can log and clear a field between scans, then remove the field.
    // Free-form diagnostics and scripting must remain denied for this share.
    return this.protectedContentSeen || (this.state?.hasSensitive ?? true);
  }
  isSensitive(backendNodeId: number): boolean {
    return this.state?.sensitiveIds.has(backendNodeId) ?? false;
  }
  /** Remember before typing, even if page script immediately clears the field. */
  remember(value: string): void {
    if (this.failed) throw deny("secret_limit");
    if (!value || this.values.has(value)) return;
    const encoded = encoder.encode(value);
    if (
      this.values.size >= MAX_VALUES ||
      this.bytes + encoded.byteLength > MAX_SECRET_BYTES ||
      encoded.byteLength > 16384
    ) {
      this.failed = true;
      throw deny("secret_limit");
    }
    this.values.add(value);
    this.bytes += encoded.byteLength;
    const b64 = btoa(Array.from(encoded, (byte) => String.fromCharCode(byte)).join(""));
    const uri = encodeURIComponent(new TextDecoder().decode(encoded));
    for (const variant of [
      value,
      uri,
      uri.replace(/%20/g, "+"),
      b64,
      b64.replace(/=/g, ""),
      b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
      JSON.stringify(value).slice(1, -1),
    ]) {
      this.variants.add(variant);
    }
    this.replacement = undefined;
  }
  sanitize(value: unknown): unknown {
    if (this.failed) throw deny("secret_limit");
    if (!this.variants.size) return value;
    this.replacement ??= new RegExp(
      [...this.variants]
        .sort((a, b) => b.length - a.length)
        .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    );
    const replace = (text: string) =>
      text
        .split(REDACTED)
        .map((part) => part.replace(this.replacement as RegExp, REDACTED))
        .join(REDACTED);
    const visit = (item: unknown, depth: number): unknown => {
      if (depth > 100) throw deny("result_depth");
      if (typeof item === "string") return replace(item);
      if (typeof item === "number" && [...this.values].some((v) => v === String(item)))
        return REDACTED;
      if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
      if (item !== null && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, val]) => [replace(key), visit(val, depth + 1)]),
        );
      return item;
    };
    return visit(value, 0);
  }
  async scan(): Promise<void> {
    if (this.failed) throw deny("secret_limit");
    try {
      const snapshot = record(
        await this.cdp("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includeDOMRects: true,
        }),
      );
      if (
        !Array.isArray(snapshot.documents) ||
        !snapshot.documents.length ||
        !Array.isArray(snapshot.strings)
      )
        throw deny();
      const strings = snapshot.strings;
      const string = (index: unknown): string => {
        // Chromium uses -1 for empty strings, including an empty live input value.
        if (index === -1) return "";
        if (!Number.isInteger(index) || typeof strings[Number(index)] !== "string") throw deny();
        return strings[Number(index)] as string;
      };
      const masks: MaskRect[] = [];
      const sensitiveIds = new Set<number>();
      let hasSensitive = false;
      let totalNodes = 0;
      for (let docIndex = 0; docIndex < snapshot.documents.length; docIndex++) {
        const document = record(snapshot.documents[docIndex]);
        const nodes = record(document.nodes);
        const layout = record(document.layout);
        if (
          ![
            nodes.nodeName,
            nodes.backendNodeId,
            nodes.attributes,
            layout.nodeIndex,
            layout.bounds,
          ].every(Array.isArray)
        )
          throw deny();
        const names = array(nodes.nodeName);
        const ids = array(nodes.backendNodeId);
        const attrs = array(nodes.attributes);
        const inputs = sparse(nodes.inputValue);
        const textareas = sparse(nodes.textValue);
        const childDocuments = sparse(nodes.contentDocumentIndex);
        const sensitiveSelects = new Set<number>();
        totalNodes += names.length;
        if (totalNodes > MAX_NODES) throw deny("node_limit");
        if (ids.length !== names.length || attrs.length !== names.length) throw deny();
        const geometry = new Map<number, MaskRect[]>();
        const bounds = array(layout.bounds);
        const indexes = array(layout.nodeIndex);
        if (bounds.length !== indexes.length) throw deny();
        for (let i = 0; i < indexes.length; i++) {
          const nodeIndex = Number(indexes[i]);
          if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= names.length)
            throw deny();
          const boxes = geometry.get(nodeIndex) ?? [];
          boxes.push(rectangle(bounds[i]));
          geometry.set(nodeIndex, boxes);
        }
        for (let i = 0; i < names.length; i++) {
          const name = string(names[i]).toUpperCase();
          const attributes = new Map<string, string>();
          const pairs = array(attrs[i]);
          if (pairs.length % 2) throw deny();
          for (let j = 0; j < pairs.length; j += 2)
            attributes.set(string(pairs[j]).toLowerCase(), string(pairs[j + 1]));
          const field = ["INPUT", "TEXTAREA", "SELECT"].includes(name) && sensitive(attributes);
          const frame = ["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(name);
          if (frame && !childDocuments.has(i)) {
            hasSensitive = true;
            this.protectedContentSeen = true;
          }
          if (field) {
            hasSensitive = true;
            this.protectedContentSeen = true;
            if (!Number.isInteger(ids[i])) throw deny();
            sensitiveIds.add(Number(ids[i]));
            if (name === "SELECT") sensitiveSelects.add(i);
            for (const value of [inputs.get(i), textareas.get(i)])
              if (value !== undefined) this.remember(string(value));
            if (attributes.has("value")) this.remember(attributes.get("value") as string);
          }
          // Child documents are covered by the complete owner frame rectangle.
          // Missing layout entry means no LayoutObject (display:none/hidden).
          if (docIndex === 0 && (field || frame))
            masks.push(...(geometry.get(i) ?? []).filter((box) => box.width > 0 && box.height > 0));
        }
        if (sensitiveSelects.size) {
          const parents = array(nodes.parentIndex);
          const text = array(nodes.nodeValue);
          if (parents.length !== names.length || text.length !== names.length) throw deny();
          for (const selected of array(record(nodes.optionSelected).index)) {
            const option = Number(selected);
            let parent = Number(parents[option]);
            const visited = new Set<number>();
            while (parent >= 0 && !visited.has(parent) && !sensitiveSelects.has(parent)) {
              visited.add(parent);
              parent = Number(parents[parent]);
            }
            if (!sensitiveSelects.has(parent)) continue;
            const pairs = array(attrs[option]);
            for (let j = 0; j < pairs.length; j += 2)
              if (string(pairs[j]).toLowerCase() === "value") this.remember(string(pairs[j + 1]));
            for (let j = 0; j < names.length; j++)
              if (parents[j] === option) this.remember(string(text[j]));
          }
        }
      }
      const root = record(snapshot.documents[0]);
      this.protectedContentSeen ||= hasSensitive;
      this.state = {
        frame: string(root.frameId),
        document: string(root.documentURL),
        masks,
        sensitiveIds,
        hasSensitive,
      };
    } catch (error) {
      this.state = undefined;
      throw safeFailure(error, "inspection_failed");
    }
  }
  private async viewport(): Promise<ScreenshotClip> {
    let result: Record<string, unknown>;
    try {
      result = record(await this.cdp("Page.getLayoutMetrics"));
    } catch {
      throw deny("invalid_viewport");
    }
    const viewport = record(result.cssVisualViewport);
    if (
      ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(
        finite,
      ) ||
      Number(viewport.clientWidth) <= 0 ||
      Number(viewport.clientHeight) <= 0
    )
      throw deny("invalid_viewport");
    return {
      x: Number(viewport.pageX),
      y: Number(viewport.pageY),
      width: Number(viewport.clientWidth),
      height: Number(viewport.clientHeight),
      scale: 1,
    };
  }
  async screenshot(
    capture: (clip: ScreenshotClip) => Promise<Uint8Array>,
    requestedClip?: ScreenshotClip,
  ): Promise<Uint8Array> {
    const viewport = await this.viewport();
    await this.scan();
    const before = this.state;
    if (!before) throw deny();
    const region = requestedClip ? intersect(requestedClip, viewport) : viewport;
    if (!region.width || !region.height) throw deny("empty_clip");
    const clip = { ...region, scale: 1 };
    const png = await capture(clip);
    await this.scan();
    const after = this.state;
    const nextViewport = await this.viewport();
    if (!after || before.frame !== after.frame || before.document !== after.document)
      throw deny("document_changed");
    if (JSON.stringify(viewport) !== JSON.stringify(nextViewport)) throw deny("viewport_changed");
    if (JSON.stringify(before.masks) !== JSON.stringify(after.masks)) throw deny("masks_changed");
    try {
      return await this.maskImage(png, clip, after.masks);
    } catch (error) {
      throw safeFailure(error, "image_masking_failed");
    }
  }
}
