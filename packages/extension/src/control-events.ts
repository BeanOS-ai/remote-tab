import type { Ledger } from "@remote-tab/client";

export const MAX_CONTROL_EVENTS = 1000;
export const CONTROL_EVENTS_NOTE =
  "Local human controls recorded by this extension. These timestamps are not part of the authenticated command chain.";

export interface ControlEvent {
  readonly action: "pause" | "resume";
  readonly timestamp: string;
}

/** Extension-only metadata; never sent as an rt1 protocol envelope. */
export interface ExtensionLedger extends Ledger {
  readonly controlEvents?: readonly ControlEvent[];
}

/** Copy before asynchronous retrieval so later controls cannot change an open snapshot. */
export function snapshotControlEvents(value: unknown): readonly ControlEvent[] {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_EVENTS)
    throw new Error("Invalid local human controls");
  return Object.freeze(
    value.map((event) => {
      if (
        !event ||
        typeof event !== "object" ||
        (event.action !== "pause" && event.action !== "resume") ||
        typeof event.timestamp !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp) ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        new Date(event.timestamp).toISOString() !== event.timestamp
      )
        throw new Error("Invalid local human controls");
      return Object.freeze({ action: event.action, timestamp: event.timestamp });
    }),
  );
}
