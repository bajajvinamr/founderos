/**
 * Provider key validation route (S7.A.6).
 *
 * Unauthenticated endpoint that lets the onboarding wizard live-validate
 * an Anthropic / OpenAI / Google API key BEFORE saving it to the draft.
 *
 *   POST /api/providers/validate-key
 *     body:    { provider: "anthropic"|"openai"|"google", apiKey: string }
 *     200:     { valid: true }
 *     400:     { error: "invalid_payload", requestId, details? }
 *     401:     { error: "invalid_key", reason?, requestId }
 *     429:     { error: "provider_rate_limit"|"rate_limit_exceeded", retryAfter?, requestId }
 *     500:     { error: "validation_failed", reason, requestId }
 *
 * The endpoint is unauthenticated by design — founders use it during
 * onboarding before any board session exists. The rate limit
 * (10 / 5min / IP) is the guard against drive-by enumeration. NOT a
 * security boundary; the keys themselves are validated against the
 * provider's auth surface, which is the actual gate.
 *
 * The route handler runs inside the existing `runWithRequestContext`
 * ALS scope (set by `request-context-middleware`), so `requestId` flows
 * into Sentry tags + log lines automatically.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import {
  issueNonceLimiter,
  providerValidateKeyLimiter,
} from "../middleware/rate-limit.js";
import { logger } from "../middleware/logger.js";
import { getRequestId } from "../lib/request-context.js";
import {
  keyReferenceHash,
  validateProviderKey,
  type ValidateProviderKeyResult,
} from "../lib/provider-key-validator.js";
import { consumeNonce, issueNonce } from "../lib/validate-nonce.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const validateKeySchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"]),
  // Per TRD §5: reject body sizes > 500 chars to defend against form-paste
  // accidents (someone pasting a JSON config with a key field).
  apiKey: z.string().min(1).max(500),
  // S7.A.6 council 2026-05-08 P1 (IP-rotation defense): single-use nonce
  // issued by GET /api/providers/issue-nonce. Required — closes the bypass
  // where a residential-proxy attacker rotates IPs to defeat the per-IP
  // rate limit. The nonce wire format is `<expiresAt>.<random>.<hmac>`
  // (~110 chars) so the 500-char cap on apiKey doesn't conflict.
  nonce: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Reason → HTTP status mapping
// ---------------------------------------------------------------------------

/**
 * Map a validator's `reason` into the route's HTTP-status-coded response
 * shape. Keeps the route handler small and the test surface explicit.
 *
 * Contract:
 *   - `invalid_key`            → 401 invalid_key
 *   - `permission_denied`      → 401 invalid_key (the founder cannot
 *                                meaningfully distinguish "wrong key"
 *                                from "right key, wrong permissions"
 *                                during onboarding — both block them)
 *   - `empty_key` / unsupported → 400 invalid_payload (Zod usually catches
 *                                this; this branch handles validator-side
 *                                empty-after-trim cases)
 *   - `rate_limited`           → 429 provider_rate_limit
 *   - `timeout` / `network_error` → 500 validation_failed
 *   - anything else            → 500 validation_failed
 */
interface RouteErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

function buildErrorResponse(
  result: ValidateProviderKeyResult,
  requestId: string | undefined,
): RouteErrorResponse {
  const reason = result.reason ?? "unknown";

  if (reason === "invalid_key" || reason === "permission_denied") {
    // S7.A.6 council 2026-05-08 P3: do NOT echo the distinguishing reason
    // ("invalid_key" vs "permission_denied") to the client. Both block the
    // founder identically; surfacing the difference triages stolen keys for
    // an attacker (real-but-no-perm vs fake). The detailed reason still
    // lands in `logger.info` (with sha256 keyRef) for support correlation.
    return {
      status: 401,
      body: {
        error: "invalid_key",
        requestId,
      },
    };
  }

  if (reason === "empty_key" || reason === "unsupported_format") {
    return {
      status: 400,
      body: {
        error: "invalid_payload",
        reason,
        requestId,
      },
    };
  }

  if (reason === "rate_limited") {
    return {
      status: 429,
      body: {
        error: "provider_rate_limit",
        ...(typeof result.retryAfter === "number"
          ? { retryAfter: result.retryAfter }
          : {}),
        requestId,
      },
    };
  }

  // timeout, network_error, unknown, http_error_*, anything else.
  return {
    status: 500,
    body: {
      error: "validation_failed",
      reason,
      requestId,
    },
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function providerRoutes(_db: Db) {
  const router = Router();

  /**
   * GET /api/providers/issue-nonce
   *
   * Unauthenticated. Issues a single-use 60-second HMAC-signed nonce that
   * the validate-key endpoint requires. IP-rate-limited at 5/min — together
   * with validate-key's 10/5min, this caps total validations per IP at 5/min,
   * defeating IP-rotation attacks against the unauth validator.
   *
   * Body: empty.
   * 200: { nonce: string, expiresAt: number }   // expiresAt = epoch seconds
   * 429: { error: "rate_limit_exceeded", message, requestId }
   * 500: { error: "issue_failed", reason, requestId }
   *      (only fires if FOUNDEROS_NONCE_SECRET is missing in production —
   *      env-validation should catch this at boot, but defense in depth.)
   */
  router.get("/providers/issue-nonce", issueNonceLimiter, (req, res) => {
    const requestId = getRequestId();
    try {
      // S7.A.6 council 2026-05-08 post-fix R1 P1: bind the nonce to req.ip
      // so a rotating-proxy attacker's nonce only validates from the same
      // IP that issued it.
      const { nonce, expiresAt } = issueNonce(req.ip);
      res.status(200).json({ nonce, expiresAt });
      return;
    } catch (err) {
      logger.error(
        { err },
        "issue-nonce threw — returning 500. Likely missing FOUNDEROS_NONCE_SECRET in production.",
      );
      res.status(500).json({
        error: "issue_failed",
        reason: "configuration_error",
        requestId,
      });
      return;
    }
  });

  router.post(
    "/providers/validate-key",
    providerValidateKeyLimiter,
    async (req, res) => {
      const requestId = getRequestId();

      // Validate inline (NOT via the global `validate` middleware) so a
      // malformed payload returns the route's specified `invalid_payload`
      // shape instead of the generic Zod error handler shape. The
      // contract here is load-bearing for the chooser drawer (S7.C.2).
      const parsed = validateKeySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_payload",
          details: parsed.error.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
          requestId,
        });
        return;
      }

      const { provider, apiKey, nonce } = parsed.data;
      const keyRef = keyReferenceHash(apiKey);

      // S7.A.6 council 2026-05-08 P1: verify + consume the single-use
      // nonce BEFORE making any upstream call. A failed nonce check
      // returns 400 invalid_payload — same shape as a Zod failure — to
      // avoid distinguishing "wrong nonce" from "wrong body shape" for
      // an attacker probing the abuse model. Post-fix R1 P1: req.ip is
      // bound into the HMAC; an IP mismatch between issue and consume
      // surfaces as "bad_signature" — no oracle for the IP.
      const nonceCheck = consumeNonce(nonce, req.ip);
      if (!nonceCheck.ok) {
        logger.info(
          { provider, keyRef, outcome: "nonce_rejected", reason: nonceCheck.reason },
          "provider-key validation rejected — bad nonce",
        );
        res.status(400).json({
          error: "invalid_payload",
          reason: "invalid_nonce",
          requestId,
        });
        return;
      }

      try {
        const result = await validateProviderKey(provider, apiKey);

        if (result.valid) {
          logger.info(
            { provider, keyRef, outcome: "valid" },
            "provider-key validated",
          );
          res.status(200).json({ valid: true });
          return;
        }

        const errResponse = buildErrorResponse(result, requestId);
        logger.info(
          {
            provider,
            keyRef,
            outcome: "invalid",
            reason: result.reason,
            upstreamStatus: result.upstreamStatus,
            httpStatus: errResponse.status,
          },
          "provider-key validation rejected",
        );
        res.status(errResponse.status).json(errResponse.body);
        return;
      } catch (err) {
        // Defense in depth: validators are written to NOT throw (they
        // catch fetch rejection internally), but if a future change
        // introduces a throw we surface a consistent 500 instead of
        // letting the global error handler erase the requestId-bearing
        // contract here. Per invariants: never silently swallow non-
        // MODULE_NOT_FOUND errors — log loudly with the keyRef hash.
        logger.error(
          { err, provider, keyRef },
          "provider-key validation threw — returning 500 validation_failed",
        );
        res.status(500).json({
          error: "validation_failed",
          reason: "unknown",
          requestId,
        });
        return;
      }
    },
  );

  return router;
}
