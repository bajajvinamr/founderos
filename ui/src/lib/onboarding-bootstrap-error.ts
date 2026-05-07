/**
 * Onboarding bootstrap submit error formatter.
 *
 * Synthesis P1-E2 fix: the wizard previously did
 *   `err instanceof Error ? err.message : "Failed to bootstrap company"`
 * which discarded the HTTP status (so 401 / 402 / 403 / 409 / 5xx all
 * looked the same to the founder) AND the requestId (so support couldn't
 * grep prod logs without first interrogating the user).
 *
 * CLAUDE.md guarantees every JSON error since 2026-05-03 carries a
 * `requestId`. This formatter surfaces it as a `Reference: <id>` footer
 * whenever it exists, with a status-aware headline that tells the
 * founder what to do next.
 *
 * Pure function. No React. No DOM. Tests live in
 * `onboarding-bootstrap-error.test.ts`.
 */

import { ApiError } from "../api/client";

const GENERIC_FALLBACK = "Failed to bootstrap your company. Please try again.";

function headlineForStatus(status: number, message: string): string {
  if (status === 401) {
    return "Your sign-in session has expired. Please sign in again and retry.";
  }
  if (status === 402) {
    return (
      "An active subscription is required to complete onboarding. " +
      "Visit /settings/billing to upgrade, then retry."
    );
  }
  if (status === 403) {
    return "You do not have permission to complete this action. Ask your instance admin for access.";
  }
  if (status === 409) {
    return (
      "A company with this configuration already exists. " +
      "Check the name or pick a different one and retry."
    );
  }
  if (status >= 500 && status < 600) {
    return "We're having a temporary service issue. Please retry in a moment.";
  }
  // Unmapped 4xx (e.g., 400 validation, 418, 422, 429) — preserve the
  // original server message so validation feedback isn't masked.
  return message;
}

function withReference(headline: string, requestId: string | null): string {
  if (!requestId || requestId.trim() === "") return headline;
  return `${headline}\n\nReference: ${requestId}`;
}

export function formatBootstrapError(err: unknown): string {
  if (err instanceof ApiError) {
    return withReference(headlineForStatus(err.status, err.message), err.requestId);
  }
  if (err instanceof Error) {
    // Plain Error (TypeError, network "Failed to fetch", etc) — no
    // requestId is available because we never reached the server, so no
    // Reference footer.
    return err.message || GENERIC_FALLBACK;
  }
  return GENERIC_FALLBACK;
}
