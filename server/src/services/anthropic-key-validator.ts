/**
 * Anthropic API key validator.
 *
 * Validates that an Anthropic API key is valid by making a test request
 * to the Anthropic API. This prevents silent failures downstream when
 * an invalid key is saved during onboarding.
 */

export interface ValidateAnthropicKeyResult {
  valid: boolean;
  reason?: string;
  /** When provider returns 429, this surfaces the upstream Retry-After hint (seconds). */
  retryAfter?: number;
  /** HTTP status from upstream — useful for diagnostics in callers. */
  upstreamStatus?: number;
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = Math.floor((dateMs - Date.now()) / 1000);
    if (delta >= 0) return delta;
  }
  return undefined;
}

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
// S7.A.6 council 2026-05-08 P2: standardized to 5s across all providers
// (was 10s — created a timing oracle distinguishing Anthropic from
// OpenAI/Google and violated the route's documented 5s contract).
const VALIDATION_TIMEOUT_MS = 5_000;

export async function validateAnthropicKey(
  apiKey: string,
): Promise<ValidateAnthropicKeyResult> {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    return {
      valid: false,
      reason: "empty_key",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": trimmed,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 200) {
      return { valid: true };
    }

    if (response.status === 401) {
      return {
        valid: false,
        reason: "invalid_key",
        upstreamStatus: 401,
      };
    }

    if (response.status === 403) {
      return {
        valid: false,
        reason: "permission_denied",
        upstreamStatus: 403,
      };
    }

    // S7.A.6 council 2026-05-08 P2: explicit 429 mapping so upstream throttling
    // surfaces as `rate_limited` (which the route maps to 429 provider_rate_limit)
    // instead of falling through to the generic 500 validation_failed branch.
    if (response.status === 429) {
      return {
        valid: false,
        reason: "rate_limited",
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        upstreamStatus: 429,
      };
    }

    // 5xx and any other unmapped status — surface as network_error so the
    // route maps to 500 validation_failed, not a misleading 401 invalid_key.
    return {
      valid: false,
      reason: response.status >= 500 ? "network_error" : `http_error_${response.status}`,
      upstreamStatus: response.status,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      return {
        valid: false,
        reason: "timeout",
      };
    }

    // Network error or other issue
    return {
      valid: false,
      reason: "network_error",
    };
  }
}
