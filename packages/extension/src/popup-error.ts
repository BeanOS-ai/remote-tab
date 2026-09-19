import { RemoteTabError } from "@remote-tab/client";

/** Keep relay refusals distinct from network failures without displaying server-supplied text. */
export function popupError(error: unknown): string {
  if (error instanceof RemoteTabError) {
    if (error.code === "redeem_window_closed")
      return "This code expired (codes last 10 minutes). Ask your agent for a new one.";
    if (error.code === "already_redeemed") return "This code was already used — tell your agent";
    if (error.code === "timeout") return "The request timed out. Try again.";
    if (error.code === "aborted") return "Sharing cancelled";
    return "Sharing could not be updated. Ask your agent to check the session.";
  }
  // Browser fetch rejects network failures with TypeError. Other local failures retain
  // actionable Chrome/consent errors, rather than being labelled connectivity problems.
  if (
    error instanceof TypeError &&
    /^(Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/.test(
      error.message,
    )
  )
    return "Could not connect. Check your connection and try again.";
  if (error instanceof Error) return error.message;
  return "Sharing could not be updated. Reopen the popup and try again.";
}
