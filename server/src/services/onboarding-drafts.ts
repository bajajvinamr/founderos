/**
 * Sprint 6 · S6.8 — onboarding draft service.
 *
 * Save-and-resume backbone for the founder onboarding wizard. The UI
 * keeps draft state in useState (FounderOnboardingWizard); this service
 * persists it server-side so reload, browser-close, or cross-device
 * resume all work.
 *
 * Atomicity model:
 *   - Each user has at most one in-progress draft (DB-level partial
 *     UNIQUE on user_id WHERE completed_at IS NULL).
 *   - `getOrCreate` returns the existing in-progress draft or creates a
 *     fresh one — idempotent for first-load + reload cases.
 *   - `save` is a conditional UPDATE keyed on the in-progress draft for
 *     this user; if there's no in-progress draft, returns null.
 *   - `complete` flips completedAt = now; once set, the row is no longer
 *     in-progress and any further `save` for this user creates a new
 *     draft (rare — typically a one-shot wizard).
 */

import { and, eq, isNull, desc, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { onboardingDrafts, ONBOARDING_TOTAL_STEPS } from "@founderos/db";

export interface OnboardingDraft {
  id: string;
  userId: string;
  currentStep: number;
  /** Opaque wizard state; the wizard owns the shape. */
  draft: Record<string, unknown>;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDraft(row: typeof onboardingDrafts.$inferSelect): OnboardingDraft {
  return {
    id: row.id,
    userId: row.userId,
    currentStep: row.currentStep,
    draft: (row.draftJson ?? {}) as Record<string, unknown>,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function onboardingDraftService(db: Db) {
  /**
   * Return the user's in-progress draft, creating an empty one if none
   * exists. Idempotent — safe to call on every wizard mount.
   */
  async function getOrCreate(userId: string): Promise<OnboardingDraft> {
    const [existing] = await db
      .select()
      .from(onboardingDrafts)
      .where(
        and(
          eq(onboardingDrafts.userId, userId),
          isNull(onboardingDrafts.completedAt),
        ),
      )
      .limit(1);

    if (existing) return toDraft(existing);

    // Insert a new draft. Concurrent first-loads can race here; the
    // partial UNIQUE will reject the loser. Retry-once-on-conflict pattern.
    try {
      const [row] = await db
        .insert(onboardingDrafts)
        .values({ userId, currentStep: 1, draftJson: {} })
        .returning();
      return toDraft(row);
    } catch {
      // Conflict — another concurrent caller created it. Re-read.
      const [retry] = await db
        .select()
        .from(onboardingDrafts)
        .where(
          and(
            eq(onboardingDrafts.userId, userId),
            isNull(onboardingDrafts.completedAt),
          ),
        )
        .limit(1);
      if (!retry) {
        throw new Error("onboarding-draft race: insert failed but no row found on retry");
      }
      return toDraft(retry);
    }
  }

  /**
   * Persist progress for the in-progress draft. Returns the updated row,
   * or null if the user has no in-progress draft (e.g. they completed it
   * and reloaded before redirecting).
   */
  async function save(
    userId: string,
    input: { currentStep: number; draft: Record<string, unknown> },
  ): Promise<OnboardingDraft | null> {
    if (
      !Number.isInteger(input.currentStep) ||
      input.currentStep < 1 ||
      input.currentStep > ONBOARDING_TOTAL_STEPS
    ) {
      throw new Error(
        `currentStep must be an integer between 1 and ${ONBOARDING_TOTAL_STEPS}`,
      );
    }

    const result = await db
      .update(onboardingDrafts)
      .set({
        currentStep: input.currentStep,
        draftJson: input.draft,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(onboardingDrafts.userId, userId),
          isNull(onboardingDrafts.completedAt),
        ),
      )
      .returning();

    return result[0] ? toDraft(result[0]) : null;
  }

  /**
   * Mark the user's in-progress draft as completed. Idempotent: if no
   * in-progress draft exists, returns null. Once completed, the row stays
   * for audit; subsequent getOrCreate calls return a fresh draft.
   */
  async function complete(userId: string): Promise<OnboardingDraft | null> {
    const result = await db
      .update(onboardingDrafts)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(onboardingDrafts.userId, userId),
          isNull(onboardingDrafts.completedAt),
        ),
      )
      .returning();

    return result[0] ? toDraft(result[0]) : null;
  }

  /**
   * Diagnostic / audit: list this user's drafts (in-progress + completed)
   * newest-first. Used by support tooling.
   */
  async function listForUser(userId: string): Promise<OnboardingDraft[]> {
    const rows = await db
      .select()
      .from(onboardingDrafts)
      .where(eq(onboardingDrafts.userId, userId))
      .orderBy(desc(onboardingDrafts.createdAt));
    return rows.map(toDraft);
  }

  return { getOrCreate, save, complete, listForUser };
}
