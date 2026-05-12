/**
 * OpenAI API key validator.
 *
 * Validates that an OpenAI API key is live by calling GET /v1/models.
 * NEVER logs the key or the Authorization header value — only a last-4 hint
 * at debug level.
 *
 * Council conditions (TA01):
 * - AbortSignal.timeout(5000) — 5 second timeout
 * - No plaintext key in error messages or logs
 * - Response shape: { valid: true } | { valid: false, reason: "bad_key" | "timeout" | "network_error" }
 */

import { logger } from "../middleware/logger.js";

export type OpenaiKeyValidationResult =
  | { valid: true }
  | { valid: false; reason: "bad_key" | "timeout" | "network_error" };

const VALIDATION_TIMEOUT_MS = 5_000;

/**
 * Validates an OpenAI API key by hitting GET /v1/models.
 * NEVER logs the key — only the last-4 hint.
 * Returns { valid: false, reason: "bad_key" } on HTTP 401 or 403.
 * Returns { valid: false, reason: "timeout" } on AbortSignal timeout.
 * Returns { valid: false, reason: "network_error" } on fetch failure.
 */
export async function validateOpenaiKey(key: string): Promise<OpenaiKeyValidationResult> {
  const trimmed = key.trim();
  // Log only a hint — NEVER the full key.
  const hint = trimmed.length >= 4 ? "…" + trimmed.slice(-4) : "****";

  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        // Key is in the header, not a URL query param — no URL-based leak risk.
        Authorization: `Bearer ${trimmed}`,
      },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });

    if (response.status === 200) {
      logger.debug({ keyHint: hint }, "openai-key-validator: key valid");
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      logger.debug({ keyHint: hint, status: response.status }, "openai-key-validator: bad_key");
      return { valid: false, reason: "bad_key" };
    }

    // 5xx or any other status — treat as network_error so the UI doesn't
    // mislead the user into thinking their key is invalid.
    logger.debug({ keyHint: hint, status: response.status }, "openai-key-validator: network_error (unexpected status)");
    return { valid: false, reason: "network_error" };
  } catch (err) {
    // AbortSignal.timeout throws a DOMException with name "TimeoutError"
    // (or an AbortError in some environments).
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      logger.debug({ keyHint: hint }, "openai-key-validator: timeout");
      return { valid: false, reason: "timeout" };
    }

    // Sanitize: re-throw details as a message that does not include the key.
    const sanitizedReason = err instanceof Error ? err.name : "unknown";
    logger.debug({ keyHint: hint, reason: sanitizedReason }, "openai-key-validator: network_error");
    return { valid: false, reason: "network_error" };
  }
}
