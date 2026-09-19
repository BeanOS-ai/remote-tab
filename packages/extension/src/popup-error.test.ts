import { expect, test } from "bun:test";
import { RemoteTabError } from "@remote-tab/client";
import { popupError } from "./popup-error";

test("expired and already-redeemed codes have distinct actionable popup errors", () => {
  expect(popupError(new RemoteTabError("redeem_window_closed", "private server text", 410))).toBe(
    "This code expired (codes last 10 minutes). Ask your agent for a new one.",
  );
  expect(popupError(new RemoteTabError("already_redeemed", "private server text", 409))).toBe(
    "This code was already used — tell your agent",
  );
});

test("only network failures are labelled Could not connect", () => {
  expect(popupError(new TypeError("Failed to fetch"))).toContain("Could not connect");
  for (const error of [
    new RemoteTabError("invalid", "private server text", 500),
    new RemoteTabError("timeout", "HTTP request timed out"),
    new RemoteTabError("aborted", "Operation aborted"),
    new TypeError("Programming error"),
    new Error("Sharing cancelled"),
    undefined,
  ]) {
    expect(popupError(error)).not.toContain("Could not connect");
    expect(popupError(error)).not.toContain("private server text");
  }
  expect(popupError(new Error("Sharing cancelled"))).toBe("Sharing cancelled");
});
