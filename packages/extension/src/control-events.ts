import type { Ledger } from "@remote-tab/client";

export const MAX_CONTROL_EVENTS = 1000;
export const CONTROL_EVENTS_NOTE =
  "Local controls recorded by this extension: human pause/resume and why sharing stopped. These timestamps are not part of the authenticated command chain.";

/** Why this extension ended a share. A fixed set, so no page or server text reaches the ledger. */
export const STOP_REASONS = {
  human: "You clicked Stop",
  agent: "Your agent stopped sharing",
  expired: "The sharing time ran out",
  tab_closed: "The shared tab was closed",
  debugger_detached: "Chrome ended control of the tab",
  scope_lost: "The tab left the shared site",
  unsafe_page: "The page could no longer be controlled safely",
  remote_ended: "The session was ended remotely, by your agent or the server",
  connection_lost: "The connection to the server failed",
} as const;
export type StopReason = keyof typeof STOP_REASONS;

export type ControlEvent =
  | { readonly action: "pause" | "resume"; readonly timestamp: string }
  | { readonly action: "stop"; readonly reason: StopReason; readonly timestamp: string };

/** Extension-only metadata; never sent as an rt1 protocol envelope. */
export interface ExtensionLedger extends Ledger {
  readonly controlEvents?: readonly ControlEvent[];
}

const isStopReason = (value: unknown): value is StopReason =>
  typeof value === "string" && Object.hasOwn(STOP_REASONS, value);

/** Copy before asynchronous retrieval so later controls cannot change an open snapshot. */
export function snapshotControlEvents(value: unknown): readonly ControlEvent[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_EVENTS)
    throw new Error("Invalid local human controls");
  return Object.freeze(
    value.map((event): ControlEvent => {
      if (
        !event ||
        typeof event !== "object" ||
        (event.action !== "pause" && event.action !== "resume" && event.action !== "stop") ||
        (event.action === "stop" ? !isStopReason(event.reason) : "reason" in event) ||
        typeof event.timestamp !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp) ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        new Date(event.timestamp).toISOString() !== event.timestamp
      )
        throw new Error("Invalid local human controls");
      return Object.freeze(
        event.action === "stop"
          ? { action: "stop", reason: event.reason, timestamp: event.timestamp }
          : { action: event.action, timestamp: event.timestamp },
      );
    }),
  );
}
