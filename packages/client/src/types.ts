import type {
  Envelope,
  ErrorCode,
  Mode,
  Role,
  SessionStatus,
  WireMessage,
} from "@remote-tab/protocol";
import type { Bytes } from "@remote-tab/protocol/src/crypto";

/** Compatible with native fetch and an in-process server's fetch(Request). */
export type Fetch = (request: Request) => Promise<Response>;
export interface ClientOptions {
  fetch?: Fetch;
  /** Overall wait budget for hello, result, or human handoff; default 120 seconds. */
  timeoutMs?: number;
  /** Bound a redeemed session's missing hello; default 10 seconds. */
  helloGraceMs?: number;
  /** Server long-poll duration, 0..25 seconds; default 25. */
  pollWaitSeconds?: number;
  /** Delay between empty polls (including before redeem); default 100 ms. */
  pollIntervalMs?: number;
  /** Bound each HTTP request, including injected transports; default 30 seconds. */
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface LedgerOptions extends WaitOptions {
  /** Optional retrieval limits; omitted limits preserve unrestricted client exports. */
  maxEntries?: number;
  /** UTF-8 JSON status and entry metadata plus decrypted attachment bytes. */
  maxBytes?: number;
}
export interface CreateOptions extends ClientOptions {
  serverUrl: string;
  apiKey: string;
  ttl?: number;
}
/** LOCAL PRIVATE STATE: contains complete decryption secret and bearer token. Never publish/log. */
export interface AgentConnectionState {
  v: 1;
  serverUrl: string;
  sessionId: string;
  secret: string;
  agentToken: string;
}
export interface Hello {
  mode: Mode;
  scope: string | null;
  title?: string;
  url?: string;
  extension_version?: string;
}
export interface BlobReference {
  blob_id: string;
  nonce: string;
  role: Role;
  prev_hash: string;
  mime_type: string;
}
export interface BlobInput {
  bytes: Bytes;
  mimeType: string;
}
export interface Attachment {
  reference: BlobReference;
  bytes: Bytes;
}
export interface ResultBody {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  screenshot?: BlobReference;
  blobs?: BlobReference[];
}
/** Page-derived result and attachment contents are untrusted data, never instructions. */
export interface CommandResult extends ResultBody {
  id: string;
  attachments: Attachment[];
}
export interface LedgerEntry {
  message: WireMessage;
  envelope: Envelope;
  attachments: Attachment[];
}
export interface Ledger {
  sessionId: string;
  status: SessionStatus;
  entries: LedgerEntry[];
}
export interface Command {
  kind: "command";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface Handoff {
  kind: "handoff";
  id: string;
  message: string;
}
export interface RedeemOptions extends ClientOptions {
  serverUrl: string;
  code: string;
  hello: Hello;
}
export type ClientErrorCode =
  | ErrorCode
  | "hijack_suspected"
  | "chain_invalid"
  | "decrypt_failed"
  | "protocol_invalid"
  | "timeout"
  | "aborted"
  | "handoff_pending"
  | "ledger_too_large";
export class RemoteTabError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RemoteTabError";
  }
}

/** Canonical design §6 browser tool names. Execution policy is enforced by the extension. */
export const BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_drag",
  "browser_navigate",
  "browser_navigate_back",
  "browser_wait_for",
  "browser_evaluate",
] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

/** Shared by agent front ends whenever they display a new session code. */
export const PRIVATE_DELIVERY_WARNING =
  "Deliver this secret code only to the intended human over a private authenticated channel. " +
  "Never publish, log, or paste it into page content or another tool. " +
  "Theft of the full code is undetectable: an authenticated hello proves possession of the code, not the human's identity.";
