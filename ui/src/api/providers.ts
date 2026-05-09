/**
 * @fileoverview Frontend API client for live provider-key validation
 * during the onboarding wizard.
 *
 * The server-side endpoint (`POST /api/providers/validate-key`, S7.A.6)
 * is unauthenticated by design — founders use it before any board
 * session exists. It is rate-limited per-IP and bound to a single-use
 * 60-second nonce issued by `GET /api/providers/issue-nonce`. This
 * module hides the nonce dance from callers — `validateProviderKey()`
 * fetches the nonce, posts the key, and surfaces a single
 * `{ valid, reason? }` shape regardless of which HTTP status the server
 * returned.
 *
 * The wizard wires this to a 600ms debounced typing handler. Stale
 * requests (when the user keeps typing) are cancelled via AbortSignal,
 * which propagates into both `fetch()` calls and surfaces as
 * `AbortError` to the caller.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Caller-facing types
// ---------------------------------------------------------------------------

/**
 * Provider identifier used by the wizard. We accept the legacy
 * `openai_api` alias for parity with the brief; the server contract
 * uses the bare provider name (`openai`), so we translate at the wire.
 */
export type ProviderId = "anthropic" | "openai_api";

/**
 * Discriminated result returned by `validateProviderKey()`. The shape is
 * intentionally narrow: callers don't need to know which HTTP status
 * the server returned, only whether the key is valid and (if not) why.
 *
 * `aborted: true` is set for AbortError, so the wizard can ignore stale
 * results without treating them as validation failures.
 */
export interface ValidateProviderKeyResult {
  valid: boolean;
  /**
   * Stable reason code when `valid === false`. The server's reasons
   * follow the validator contract (`invalid_key`, `permission_denied`,
   * `rate_limited`, `network_error`, `timeout`, ...). Two extra
   * client-side reasons surface here:
   *   - `network_error` — fetch threw (offline, CORS, etc.)
   *   - `rate_limited`  — 429 from either issue-nonce or validate-key
   *   - `nonce_failed`  — issue-nonce returned non-200 / unparseable
   *   - `unknown`       — fallback when the server's body is missing
   */
  reason?: string;
  /**
   * True iff the call was aborted via the caller's AbortSignal. The
   * wizard should treat aborted calls as no-ops (don't update status).
   */
  aborted?: boolean;
}

// ---------------------------------------------------------------------------
// Wire schemas — narrow `unknown` JSON into typed values
// ---------------------------------------------------------------------------

const issueNonceResponseSchema = z.object({
  nonce: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

/**
 * Success body shape from `POST /api/providers/validate-key` (HTTP 200).
 * The server intentionally sends `{ valid: true }` only on the happy
 * path; failures arrive as 4xx/5xx with `{ error, reason?, requestId }`.
 */
const validateKeySuccessSchema = z.object({
  valid: z.literal(true),
});

/**
 * Error body shape for 4xx/5xx responses. `reason` is optional because
 * 401 invalid_key intentionally suppresses the distinguishing reason
 * to avoid triaging stolen keys for an attacker (see route comment).
 */
const validateKeyErrorSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  retryAfter: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Translate the wizard's provider id to the server's wire value. */
function toServerProvider(provider: ProviderId): "anthropic" | "openai" {
  return provider === "openai_api" ? "openai" : "anthropic";
}

/**
 * Try to parse a JSON response body without throwing. We return
 * `unknown` so the caller has to narrow it through Zod (or treat it as
 * malformed and fall back). Never returns `any`.
 */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Detect whether an error originated from an aborted fetch. Both
 * native `AbortError` and the `signal.aborted` flag are checked because
 * test runners (and some polyfills) surface the abort state slightly
 * differently.
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

interface IssueNonceOk {
  ok: true;
  nonce: string;
}
interface IssueNonceErr {
  ok: false;
  reason: "rate_limited" | "nonce_failed" | "network_error";
}
type IssueNonceResult = IssueNonceOk | IssueNonceErr;

async function fetchNonce(signal?: AbortSignal): Promise<IssueNonceResult> {
  let res: Response;
  try {
    res = await fetch("/api/providers/issue-nonce", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    return { ok: false, reason: "network_error" };
  }

  if (res.status === 429) {
    return { ok: false, reason: "rate_limited" };
  }
  if (!res.ok) {
    return { ok: false, reason: "nonce_failed" };
  }

  const body = await safeJson(res);
  const parsed = issueNonceResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: "nonce_failed" };
  }
  return { ok: true, nonce: parsed.data.nonce };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a provider API key live, before the onboarding wizard
 * advances. Two-step round trip under the hood:
 *
 *   1. GET  /api/providers/issue-nonce       (single-use 60s nonce)
 *   2. POST /api/providers/validate-key      ({ provider, apiKey, nonce })
 *
 * Returns a narrow `{ valid, reason?, aborted? }` shape. Throws ONLY
 * on AbortError (rethrown so callers can `if (err.name === "AbortError")
 * return`); every other transport failure surfaces as `{ valid: false,
 * reason: "network_error" }`.
 */
export async function validateProviderKey(
  provider: ProviderId,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ValidateProviderKeyResult> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "empty_key" };
  }

  // Step 1: issue-nonce. AbortError propagates so the caller's stale
  // promise never resolves with a misleading "valid: false" result.
  let nonceResult: IssueNonceResult;
  try {
    nonceResult = await fetchNonce(signal);
  } catch (err) {
    if (isAbortError(err, signal)) {
      return { valid: false, aborted: true };
    }
    return { valid: false, reason: "network_error" };
  }
  if (!nonceResult.ok) {
    return { valid: false, reason: nonceResult.reason };
  }

  // Step 2: validate-key.
  let res: Response;
  try {
    res = await fetch("/api/providers/validate-key", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        provider: toServerProvider(provider),
        apiKey: trimmed,
        nonce: nonceResult.nonce,
      }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err, signal)) {
      return { valid: false, aborted: true };
    }
    return { valid: false, reason: "network_error" };
  }

  const body = await safeJson(res);

  if (res.status === 200) {
    const parsed = validateKeySuccessSchema.safeParse(body);
    if (parsed.success) {
      return { valid: true };
    }
    // Server returned 200 but the body didn't match the contract — be
    // conservative and report invalid rather than auto-pass.
    return { valid: false, reason: "unknown" };
  }

  // 4xx/5xx envelope. The server intentionally hides the precise
  // reason for 401 invalid_key (see `buildErrorResponse` in
  // server/src/routes/providers.ts), so we surface the `error` token
  // instead. Callers map this to a human-readable status.
  const parsed = validateKeyErrorSchema.safeParse(body);
  if (res.status === 429) {
    return { valid: false, reason: "rate_limited" };
  }
  if (parsed.success) {
    return {
      valid: false,
      reason: parsed.data.reason ?? parsed.data.error,
    };
  }
  return { valid: false, reason: "unknown" };
}
