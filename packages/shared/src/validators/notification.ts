/**
 * Sprint 6 · S6.6 — notification validators.
 *
 * Mirrors the CHECK constraints on `notifications.kind` + `notifications.ref_kind`
 * from migration 0100. Add new values via migration + the schema const +
 * this enum, all together.
 */

import { z } from "zod";

export const notificationKindSchema = z.enum([
  "approval_needed",
  "insight_critical",
  "workflow_completed",
  "integration_failed",
]);

export const notificationRefKindSchema = z.enum([
  "approval",
  "insight",
  "workflow_run",
  "integration",
]);

/**
 * Pair invariant — DB CHECK enforces "both null or both set"; we mirror
 * that as a refinement here so API callers get a clear error before the
 * insert hits Postgres.
 */
const refPairRefinement = (data: {
  refKind?: string | null;
  refId?: string | null;
}) => {
  const kindSet = data.refKind != null;
  const idSet = data.refId != null && data.refId !== "";
  return kindSet === idSet;
};

export const createNotificationSchema = z
  .object({
    // user.id is text (Better-Auth schema), not uuid — accept any non-empty string.
    userId: z.string().min(1).max(200),
    kind: notificationKindSchema,
    title: z.string().min(1).max(200),
    body: z.string().max(5000).nullable().optional(),
    refKind: notificationRefKindSchema.nullable().optional(),
    refId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(refPairRefinement, {
    message: "refKind and refId must be both set or both null",
    path: ["refId"],
  });

export const listNotificationsQuerySchema = z.object({
  unread: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
