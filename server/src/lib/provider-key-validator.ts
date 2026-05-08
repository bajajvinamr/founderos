/**
 * Multi-provider API key validator (S7.A.6).
 *
 * Single entry point that validates an Anthropic / OpenAI / Google API key
 * by issuing a CHEAP read-only auth-exercising request to the provider.
 * Returns a structured `{ valid, reason }` result. Used by:
 *   - POST /api/providers/validate-key (live validation during onboarding)
 *   - server/src/routes/onboarding.ts:265 (defense-in-depth on bootstrap)
 *
 * Anthropic logic is delegated to `services/anthropic-key-validator.ts`
 * (single source of truth — do NOT duplicate the call shape here). This
 * module wires OpenAI + Google in the same shape and exposes a unified
 * dispatcher.
 *
 * Security:
 *   - The raw key is NEVER logged anywhere, even truncated. Telemetry
 *     uses a domain-separated HMAC token via `keyReferenceHash()` —
 *     stable, opaque, and information-theoretically non-reversible.
 *   - 5-second wall-clock timeout per provider call (per ticket spec).
 *     Timeouts surface as `reason: "timeout"`, not `invalid_key`.
 */

import { createHmac } from "node:crypto";
import {
  validateAnthropicKey,
  type ValidateAnthropicKeyResult,
} from "../services/anthropic-key-validator.js";

/**
 * Domain separator for the telemetry key-reference HMAC. Hardcoded
 * (not an env var) so that log correlation is stable across deploys
 * and process restarts — rotating this would orphan every prior log
 * line that referenced a key by hash, breaking support workflows.
 *
 * Treat this as a versioned constant: bump the suffix (`-v2`, `-v3`)
 * only if a deliberate correlation-graph reset is required.
 */
const KEY_REFERENCE_HMAC_DOMAIN = "founderos:provider-key-ref:v1";

export type ProviderName = "anthropic" | "openai" | "google";

/**
 * Stable reason codes — UI maps to copy. Kept in sync with the Anthropic
 * validator's existing string codes (`empty_key`, `invalid_key`,
 * `permission_denied`, `network_error`, `timeout`).
 */
export type ValidationReason =
  | "empty_key"
  | "invalid_key"
  | "permission_denied"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "unsupported_format"
  | "unknown";

export interface ValidateProviderKeyResult {
  valid: boolean;
  reason?: ValidationReason | string;
  /** When provider returns 429, this surfaces the upstream Retry-After hint (seconds). */
  retryAfter?: number;
  /** HTTP status from upstream — useful for 5xx → `network_error` mapping in callers. */
  upstreamStatus?: number;
}

const VALIDATION_TIMEOUT_MS = 5_000;
const OPENAI_API_BASE = "https://api.openai.com";
const GOOGLE_GENAI_BASE = "https://generativelanguage.googleapis.com";

/**
 * Returns a 12-char telemetry-correlation token for the given API key.
 *
 * THIS IS NOT A PASSWORD HASH. It is a stable opaque reference used
 * exclusively for log-line correlation — given the same key in two
 * different requests, the same token is emitted so support can join
 * log lines by `keyRef`. The threat model is:
 *
 *   "An operator with read-only log access must not be able to recover
 *    the plaintext API key from the logged token."
 *
 * Construction: HMAC-SHA256 with a fixed domain separator, truncated
 * to 48 bits (12 hex chars). The domain separator defeats rainbow-table
 * lookups even if an attacker holds a candidate key list — they would
 * also need our codebase to compute matching HMACs.
 *
 * Why not bcrypt/scrypt/argon2: those are calibrated to slow down brute-
 * force of LOW-ENTROPY user passwords. API keys are 64+ chars of CSPRNG
 * output (~256 bits of entropy); slow hashing buys zero marginal security
 * here. Worse, slow hashes cost ~100ms per call — we hash on every log
 * line in the validation path, and a 100ms cost there blocks the pino
 * event loop and cascades into request-handling latency. CodeQL's
 * `js/insufficient-password-hash` rule pattern-matches on `apiKey`
 * variable names; switching to HMAC moves us out of that sink predicate
 * AND aligns the primitive with the actual threat model (rainbow-table
 * defense, not preimage hardening of low-entropy material).
 *
 * Why truncate to 48 bits: collisions are acceptable for telemetry
 * (two distinct keys hashing to the same token is a soft correlation,
 * never used for auth). Preimage recovery from the truncated digest
 * is information-theoretically impossible — a single 48-bit digest
 * collides with ~2^208 distinct 64-char keys, so an attacker cannot
 * single-out the original input even in the worst case.
 */
export function keyReferenceHash(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return "empty";
  return createHmac("sha256", KEY_REFERENCE_HMAC_DOMAIN)
    .update(trimmed)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Validate an OpenAI API key by GET-ing /v1/models. Lists models without
 * burning any token quota; returns 200 on a valid key, 401 on invalid,
 * 429 on rate-limited, 5xx on upstream failure (treated as network_error).
 */
export async function validateOpenAIKey(
  apiKey: string,
): Promise<ValidateProviderKeyResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { valid: false, reason: "empty_key" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${OPENAI_API_BASE}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${trimmed}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 200) return { valid: true };
    if (response.status === 401) {
      return { valid: false, reason: "invalid_key", upstreamStatus: 401 };
    }
    if (response.status === 403) {
      return { valid: false, reason: "permission_denied", upstreamStatus: 403 };
    }
    if (response.status === 429) {
      return {
        valid: false,
        reason: "rate_limited",
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        upstreamStatus: 429,
      };
    }
    return {
      valid: false,
      reason: "network_error",
      upstreamStatus: response.status,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return { valid: false, reason: "timeout" };
    }
    return { valid: false, reason: "network_error" };
  }
}

/**
 * Validate a Google (Gemini API) key by GET-ing /v1beta/models with the
 * key in the `x-goog-api-key` header. Per Google's Generative Language API
 * contract, a 200 means the key authenticates against the listed models;
 * 400 / 403 / 401 all signal an invalid key (Google returns 400 with
 * `INVALID_ARGUMENT` for bad keys and 403 for revoked / quota-exhausted keys).
 *
 * S7.A.6 council 2026-05-08 P2 (URL-leak footgun): the previous version
 * passed the key in `?key=<raw>` querystring. The validator's catch path
 * suppressed errors so the URL never reached pino — but any future HTTP
 * instrumentation (OpenTelemetry, Sentry HTTP breadcrumbs, Datadog APM)
 * would automatically capture outbound URLs in spans, leaking the key in
 * cleartext from a single observability commit. Google's documented
 * alternative is the `x-goog-api-key` header — same auth surface, no URL.
 */
export async function validateGoogleKey(
  apiKey: string,
): Promise<ValidateProviderKeyResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { valid: false, reason: "empty_key" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${GOOGLE_GENAI_BASE}/v1beta/models`, {
      method: "GET",
      headers: {
        "x-goog-api-key": trimmed,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 200) return { valid: true };
    if (response.status === 400 || response.status === 401) {
      return {
        valid: false,
        reason: "invalid_key",
        upstreamStatus: response.status,
      };
    }
    if (response.status === 403) {
      return { valid: false, reason: "permission_denied", upstreamStatus: 403 };
    }
    if (response.status === 429) {
      return {
        valid: false,
        reason: "rate_limited",
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        upstreamStatus: 429,
      };
    }
    return {
      valid: false,
      reason: "network_error",
      upstreamStatus: response.status,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return { valid: false, reason: "timeout" };
    }
    return { valid: false, reason: "network_error" };
  }
}

/**
 * Bridge: the existing Anthropic validator returns a slightly narrower
 * shape (`reason: string`). Wrap it so the dispatcher result is uniform.
 *
 * The existing module already implements the right thing (timeout via
 * AbortController, distinguishes 401 / 403 / network / timeout). We
 * delegate; we do NOT re-implement.
 */
function wrapAnthropic(
  result: ValidateAnthropicKeyResult,
): ValidateProviderKeyResult {
  return result;
}

/**
 * Dispatch a validate request to the right provider. Callers should
 * treat the `reason` field as the canonical contract; HTTP-status mapping
 * is the route layer's responsibility.
 */
export async function validateProviderKey(
  provider: ProviderName,
  apiKey: string,
): Promise<ValidateProviderKeyResult> {
  switch (provider) {
    case "anthropic":
      return wrapAnthropic(await validateAnthropicKey(apiKey));
    case "openai":
      return validateOpenAIKey(apiKey);
    case "google":
      return validateGoogleKey(apiKey);
    default: {
      // TS exhaustiveness: this branch is unreachable for the typed enum.
      const exhaustive: never = provider;
      void exhaustive;
      return { valid: false, reason: "unknown" };
    }
  }
}

/**
 * Parse an HTTP `Retry-After` header into seconds. Accepts either a
 * delta-seconds integer or an HTTP-date; falls back to undefined when
 * the header is missing or unparseable.
 */
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
