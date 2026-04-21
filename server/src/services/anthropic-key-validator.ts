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
}

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const VALIDATION_TIMEOUT_MS = 10_000;

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
      };
    }

    if (response.status === 403) {
      return {
        valid: false,
        reason: "permission_denied",
      };
    }

    // Other status codes — treat as invalid
    return {
      valid: false,
      reason: `http_error_${response.status}`,
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
