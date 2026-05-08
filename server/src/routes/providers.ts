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
import { providerValidateKeyLimiter } from "../middleware/rate-limit.js";
import { logger } from "../middleware/logger.js";
import { getRequestId } from "../lib/request-context.js";
import {
  keyReferenceHash,
  validateProviderKey,
  type ValidateProviderKeyResult,
} from "../lib/provider-key-validator.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const validateKeySchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"]),
  // Per TRD §5: reject body sizes > 500 chars to defend against form-paste
  // accidents (someone pasting a JSON config with a key field).
  apiKey: z.string().min(1).max(500),
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
    return {
      status: 401,
      body: {
        error: "invalid_key",
        reason,
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

      const { provider, apiKey } = parsed.data;
      const keyRef = keyReferenceHash(apiKey);

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
