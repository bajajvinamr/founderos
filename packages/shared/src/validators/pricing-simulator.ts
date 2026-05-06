import { z } from "zod";

/**
 * Pricing simulator (S5.2) — request body validator.
 *
 * Spec body shape from .planning/PHASES/PHASE-S5-finance.md:
 *   { tierChanges: [{ tierId, currentPriceCents, newPriceCents }] }
 */

export const tierChangeSchema = z.object({
  tierId: z.string().min(1).max(64),
  currentPriceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  newPriceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const pricingSimulateSchema = z.object({
  tierChanges: z.array(tierChangeSchema).min(1).max(20),
});

export type TierChange = z.infer<typeof tierChangeSchema>;
export type PricingSimulateBody = z.infer<typeof pricingSimulateSchema>;
