/**
 * Sprint 6 · S6.8 — onboarding draft persistence.
 *
 * Save-and-resume backbone for the founder onboarding wizard. Each user
 * has at most one in-progress draft (enforced by partial UNIQUE in
 * migration 0102); completed drafts stay for audit.
 *
 * The `draftJson` column is opaque to the server — the wizard owns the
 * shape. Validators in @founderos/shared keep the API surface honest
 * but are intentionally tolerant of unknown keys for forward compat.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  smallint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * Wizard step enum — must stay in lockstep with the CHECK constraint
 * `current_step >= 1 AND <= 8` in migration 0102 and with TOTAL_STEPS in
 * `ui/src/components/onboarding/FounderOnboardingWizard.tsx`.
 */
export const ONBOARDING_TOTAL_STEPS = 8 as const;

export const onboardingDrafts = pgTable(
  "onboarding_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** user.id is text (Better-Auth); FK ON DELETE CASCADE. */
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /** 1..8; CHECK constraint enforces the bounds at the DB layer. */
    currentStep: smallint("current_step").notNull().default(1),
    /** Opaque wizard state. Server stores + returns; never inspects. */
    draftJson: jsonb("draft_json").notNull().default({}),
    /** null = in-progress; set = wizard finished. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** One in-progress draft per user (partial unique). */
    userActiveUniqueIdx: uniqueIndex("idx_onboarding_drafts_user_active").on(
      table.userId,
    ),
    /** Per-user history (completions + active). */
    userCreatedIdx: index("idx_onboarding_drafts_user_created").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
