/**
 * Sprint 6 · S6.8 — onboarding draft validators.
 *
 * The wizard owns the shape of `draft` — server stores it as opaque
 * jsonb. Validators here only enforce the envelope (currentStep bounds,
 * draft is an object, etc.) and pass `draft` through unchanged.
 */

import { z } from "zod";

/** Mirror of CHECK constraint in migration 0102 + TOTAL_STEPS in the UI. */
export const ONBOARDING_MAX_STEP = 8;

export const onboardingStepSchema = z
  .number()
  .int()
  .min(1)
  .max(ONBOARDING_MAX_STEP);

/**
 * Save-progress payload. `draft` is intentionally `z.record(z.any())` —
 * the wizard owns the shape, the server doesn't inspect it. Forward-compat:
 * future wizard fields just persist without server changes.
 */
export const saveOnboardingDraftSchema = z.object({
  currentStep: onboardingStepSchema,
  draft: z.record(z.any()),
});

export type SaveOnboardingDraftInput = z.infer<typeof saveOnboardingDraftSchema>;
