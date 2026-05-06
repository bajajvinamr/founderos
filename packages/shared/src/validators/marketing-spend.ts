import { z } from "zod";

/**
 * Marketing spend ledger — manual ad-spend by channel + period (S5.6).
 *
 * The DB enforces the channel enum via CHECK; this Zod schema is the
 * client-facing copy. Keep both lists in sync — adding a new channel is
 * a 3-line change: schema constant, DB CHECK clause, this enum.
 */
export const MARKETING_SPEND_CHANNELS = [
  "linkedin",
  "paid_meta",
  "paid_google",
  "referral",
  "seo",
  "partnerships",
  "content",
  "other",
] as const;

export const marketingSpendChannelSchema = z.enum(MARKETING_SPEND_CHANNELS);
export type MarketingSpendChannel = z.infer<typeof marketingSpendChannelSchema>;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

export const createMarketingSpendSchema = z
  .object({
    channel: marketingSpendChannelSchema,
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    amountCents: z
      .number()
      .int()
      .min(0, "Amount cannot be negative")
      .max(Number.MAX_SAFE_INTEGER),
    currency: z.string().length(3).optional().default("USD"),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    message: "periodEnd must be on or after periodStart",
    path: ["periodEnd"],
  });

export const updateMarketingSpendSchema = z
  .object({
    channel: marketingSpendChannelSchema.optional(),
    periodStart: isoDateSchema.optional(),
    periodEnd: isoDateSchema.optional(),
    amountCents: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine(
    (data) =>
      !data.periodStart ||
      !data.periodEnd ||
      data.periodEnd >= data.periodStart,
    {
      message: "periodEnd must be on or after periodStart",
      path: ["periodEnd"],
    },
  );

export const listMarketingSpendQuerySchema = z.object({
  channel: marketingSpendChannelSchema.optional(),
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
});

export type CreateMarketingSpend = z.infer<typeof createMarketingSpendSchema>;
export type UpdateMarketingSpend = z.infer<typeof updateMarketingSpendSchema>;
export type ListMarketingSpendQuery = z.infer<
  typeof listMarketingSpendQuerySchema
>;

export interface MarketingSpendRow {
  id: string;
  companyId: string;
  channel: MarketingSpendChannel;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  currency: string;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}
