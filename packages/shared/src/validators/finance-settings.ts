import { z } from "zod";

/**
 * Finance settings — singleton-per-company manual inputs.
 *
 * Used by S5.5 runway forecast + S5.8 cash planning. Founder enters
 * cash on hand and monthly burn; everything else is computed.
 *
 * Cents are bigint at the DB layer; Zod accepts integer JS numbers up
 * to MAX_SAFE_INTEGER (2^53-1 ≈ $90 trillion at cent precision), which
 * comfortably covers any conceivable founder cash position.
 */

export const CURRENCY_CODES = ["USD", "EUR", "GBP", "INR"] as const;
export const currencySchema = z.enum(CURRENCY_CODES);

const cashCentsSchema = z
  .number()
  .int()
  .min(0, "Cash balance cannot be negative")
  .max(Number.MAX_SAFE_INTEGER);

const burnCentsSchema = z
  .number()
  .int()
  .min(0, "Monthly burn cannot be negative")
  .max(Number.MAX_SAFE_INTEGER);

export const upsertFinanceSettingsSchema = z.object({
  cashBalanceCents: cashCentsSchema,
  monthlyBurnCents: burnCentsSchema,
  currency: currencySchema.optional().default("USD"),
});

export type UpsertFinanceSettings = z.infer<typeof upsertFinanceSettingsSchema>;

export interface FinanceSettings {
  id: string;
  companyId: string;
  cashBalanceCents: number;
  monthlyBurnCents: number;
  currency: string;
  lastUpdatedAt: string; // ISO
  lastUpdatedBy: string | null;
  createdAt: string;
}
