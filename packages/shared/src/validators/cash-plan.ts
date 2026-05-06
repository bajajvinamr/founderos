import { z } from "zod";

/**
 * Cash planning scenario inputs (S5.8) — 6-month "what-if" projection
 * with toggleable adjustments stacked on top of the runway baseline.
 *
 * Each adjustment is optional and additive. All adjustments default to
 * their no-op value; an empty body returns the baseline projection.
 */

export const cashPlanHireSchema = z.object({
  salaryCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  startMonthOffset: z.number().int().min(0).max(36),
});

export const cashPlanInputSchema = z.object({
  hires: z.array(cashPlanHireSchema).max(20).default([]),
  priceChangePct: z.number().min(-50).max(200).default(0),
  churnDeltaPct: z.number().min(-50).max(50).default(0),
  monthlyMarketingSpendCents: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  horizonMonths: z.number().int().min(1).max(24).default(6),
});

export type CashPlanHire = z.infer<typeof cashPlanHireSchema>;
export type CashPlanInput = z.infer<typeof cashPlanInputSchema>;
