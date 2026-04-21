/**
 * Bring-Your-Own (BYO) API key validation routes.
 *
 * Validates user-provided API keys before saving them to the database.
 * Currently supports Anthropic, OpenAI, and Gemini keys.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { validateAnthropicKey } from "../services/anthropic-key-validator.js";
import { byoKeyValidateLimiter } from "../middleware/rate-limit.js";

const byoKeyValidateSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  key: z.string().min(4).max(10_000),
});

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function byoKeyRoutes(_db: Db) {
  const router = Router();

  /**
   * Validate an API key for a given provider without saving it.
   * Returns { valid: true } on success, or { valid: false, reason } on failure.
   *
   * Requires authenticated session (board access).
   */
  router.post(
    "/byo-key/validate",
    byoKeyValidateLimiter,
    validate(byoKeyValidateSchema),
    async (req, res) => {
      // Require authenticated board user
      if (req.actor.type !== "board") {
        throw forbidden("Board access required");
      }

      const { provider, key } = req.body as z.infer<typeof byoKeyValidateSchema>;

      let result: ValidationResult;

      if (provider === "anthropic") {
        result = await validateAnthropicKey(key);
      } else if (provider === "openai") {
        // Placeholder for OpenAI validation
        result = { valid: false, reason: "not_implemented" };
      } else if (provider === "gemini") {
        // Placeholder for Gemini validation
        result = { valid: false, reason: "not_implemented" };
      } else {
        // TypeScript exhaustiveness — should never happen
        result = { valid: false, reason: "unknown_provider" };
      }

      res.json(result);
    },
  );

  return router;
}
