/**
 * Gemini (Google AI Studio) API key validator.
 *
 * Validates a Google AI Studio API key against the generativelanguage.googleapis.com
 * models endpoint. The key is passed as a query parameter (Google API convention).
 *
 * CRITICAL — URL-key leak prevention (council condition TA02 #4):
 * - The key-bearing URL is NEVER assigned to a named variable.
 * - It is constructed inline in the fetch() call only.
 * - Any fetch error is caught and re-thrown with a sanitized message that
 *   does NOT include the URL string (which contains the key).
 * - Sentry beforeBreadcrumb filter in sentry.ts scrubs generativelanguage.googleapis.com
 *   URLs from breadcrumb data before sending.
 *
 * Council conditions (TA02):
 * - AbortSignal.timeout(5000) — 5 second timeout
 * - No plaintext key in error messages, logs, or Sentry breadcrumbs
 * - Response shape: { valid: true } | { valid: false, reason: "bad_key" | "timeout" | "network_error" }
 */

import { logger } from "../middleware/logger.js";

export type GeminiKeyValidationResult =
  | { valid: true }
  | { valid: false; reason: "bad_key" | "timeout" | "network_error" };

const VALIDATION_TIMEOUT_MS = 5_000;

/**
 * Validates a Google AI Studio API key by hitting the models list endpoint.
 * Key is passed as a query parameter (Google API convention).
 *
 * NEVER logs the key or the full URL (which contains the key). Only log
 * a hint (last 4 chars) and the HTTP status.
 *
 * Returns { valid: false, reason: "bad_key" } on HTTP 400 or 403.
 * Returns { valid: false, reason: "timeout" } on AbortSignal timeout.
 * Returns { valid: false, reason: "network_error" } on fetch failure.
 */
export async function validateGeminiKey(key: string): Promise<GeminiKeyValidationResult> {
  const trimmed = key.trim();
  // Log only a hint — NEVER the full key or the URL.
  const hint = trimmed.length >= 4 ? "…" + trimmed.slice(-4) : "****";

  let status: number | null = null;

  try {
    // CRITICAL: the key-bearing URL is constructed inline in the fetch call.
    // It is NEVER assigned to a named variable to prevent it from leaking
    // into logs, error messages, or Sentry breadcrumbs.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmed)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      },
    );

    status = response.status;

    if (status === 200) {
      logger.debug({ keyHint: hint }, "gemini-key-validator: key valid");
      return { valid: true };
    }

    if (status === 400 || status === 403) {
      // Google returns 400 for malformed/invalid key, 403 for valid format
      // but wrong permissions.
      logger.debug({ keyHint: hint, status }, "gemini-key-validator: bad_key");
      return { valid: false, reason: "bad_key" };
    }

    // 401 (sometimes used by Google for auth errors), 5xx, or any other status
    // Treat non-200 non-400/403 responses as network_error so we don't mislead
    // the user into thinking a transient server error means their key is bad.
    if (status === 401) {
      logger.debug({ keyHint: hint, status }, "gemini-key-validator: bad_key (401)");
      return { valid: false, reason: "bad_key" };
    }

    logger.debug({ keyHint: hint, status }, "gemini-key-validator: network_error (unexpected status)");
    return { valid: false, reason: "network_error" };
  } catch (err) {
    // AbortSignal.timeout throws a DOMException with name "TimeoutError"
    // (or AbortError in some environments).
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      logger.debug({ keyHint: hint }, "gemini-key-validator: timeout");
      return { valid: false, reason: "timeout" };
    }

    // Sanitize: log only the error name, NOT the message (which may contain
    // the URL including the key in some fetch implementations).
    const sanitizedReason = err instanceof Error ? err.name : "unknown";
    logger.debug({ keyHint: hint, reason: sanitizedReason }, "gemini-key-validator: network_error");
    return { valid: false, reason: "network_error" };
  }
}
