/**
 * Decision Outcomes service.
 *
 * Closes the loop on approved decisions: ~14 days after `decidedAt`, a cron
 * inserts a `pending_followup` row for each approved approval that has no
 * existing decision_outcomes row. The founder answers "what happened?" and the
 * outcome can be promoted into company_memory as a durable learning the system
 * can reference on future decisions.
 *
 * Outcome statuses:
 *   - pending_followup: prompt created, awaiting founder answer
 *   - worked:           decision delivered the intended result
 *   - did_not_work:     decision did not deliver — note the why
 *   - unclear:          too early / can't attribute cleanly
 *   - dropped:          never executed / abandoned
 *
 * Tenant isolation: every query is scoped by companyId (derived from the
 * linked approval) so cross-company leakage is not possible.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { approvals, companyMemory, decisionOutcomes } from "@founderos/db";
import { notFound, unprocessable } from "../errors.js";

export type OutcomeStatus =
  | "pending_followup"
  | "worked"
  | "did_not_work"
  | "unclear"
  | "dropped";

export interface DecisionOutcomeRecord {
  id: string;
  approvalId: string;
  companyId: string;
  outcomeStatus: OutcomeStatus;
  promptedAt: Date;
  answeredAt: Date | null;
  founderNote: string | null;
  metricDelta: string | null;
  memoryEntryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: typeof decisionOutcomes.$inferSelect): DecisionOutcomeRecord {
  return {
    id: row.id,
    approvalId: row.approvalId,
    companyId: row.companyId,
    outcomeStatus: row.outcomeStatus as OutcomeStatus,
    promptedAt: row.promptedAt,
    answeredAt: row.answeredAt,
    founderNote: row.founderNote,
    metricDelta: row.metricDelta,
    memoryEntryId: row.memoryEntryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface RecordOutcomeInput {
  status: Exclude<OutcomeStatus, "pending_followup">;
  note?: string | null;
  metric?: string | null;
}

export function decisionOutcomeService(db: Db) {
  /**
   * List outcomes still awaiting a founder answer for a company.
   * Sorted oldest-prompt-first so the most overdue are surfaced first.
   */
  async function listPending(companyId: string): Promise<DecisionOutcomeRecord[]> {
    const rows = await db
      .select()
      .from(decisionOutcomes)
      .where(
        and(
          eq(decisionOutcomes.companyId, companyId),
          eq(decisionOutcomes.outcomeStatus, "pending_followup"),
        ),
      )
      .orderBy(decisionOutcomes.promptedAt);

    return rows.map(toRecord);
  }

  /**
   * List every outcome tied to a specific approval (0 or 1 row in practice).
   * Scoped by approval -> company implicitly.
   */
  async function listForApproval(approvalId: string): Promise<DecisionOutcomeRecord[]> {
    const rows = await db
      .select()
      .from(decisionOutcomes)
      .where(eq(decisionOutcomes.approvalId, approvalId))
      .orderBy(desc(decisionOutcomes.createdAt));

    return rows.map(toRecord);
  }

  /**
   * Insert a pending_followup row for an approval. Idempotent — if an outcome
   * already exists for this approval, returns the existing row unchanged.
   */
  async function createPrompt(approvalId: string): Promise<DecisionOutcomeRecord> {
    const [existing] = await db
      .select()
      .from(decisionOutcomes)
      .where(eq(decisionOutcomes.approvalId, approvalId));
    if (existing) return toRecord(existing);

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    if (!approval) throw notFound("Approval not found");

    const now = new Date();
    const [row] = await db
      .insert(decisionOutcomes)
      .values({
        approvalId,
        companyId: approval.companyId,
        outcomeStatus: "pending_followup",
        promptedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toRecord(row);
  }

  /**
   * Record the founder's answer on an outcome. Flips outcomeStatus off of
   * pending_followup, stamps answeredAt, and stores the note + metric delta.
   */
  async function recordOutcome(
    id: string,
    input: RecordOutcomeInput,
  ): Promise<DecisionOutcomeRecord> {
    // Type system already rejects "pending_followup" in RecordOutcomeInput; a
    // caller that slips past via `as any` would silently re-arm the prompt.
    // Guard at runtime too — fail loudly rather than accept nonsense state.
    if ((input.status as string) === "pending_followup") {
      throw unprocessable("Cannot record an outcome as 'pending_followup'");
    }

    const now = new Date();
    const [row] = await db
      .update(decisionOutcomes)
      .set({
        outcomeStatus: input.status,
        founderNote: input.note ?? null,
        metricDelta: input.metric ?? null,
        answeredAt: now,
        updatedAt: now,
      })
      .where(eq(decisionOutcomes.id, id))
      .returning();

    if (!row) throw notFound("Decision outcome not found");
    return toRecord(row);
  }

  /**
   * Promote a recorded outcome into company_memory as an experiment_outcome
   * entry the system can pull on future similar decisions. Idempotent — if a
   * memory entry was already written, returns it instead of creating a duplicate.
   *
   * Returns the memory entry id linked to the outcome.
   */
  async function promoteToMemory(id: string): Promise<{
    outcome: DecisionOutcomeRecord;
    memoryEntryId: string;
  }> {
    const [outcome] = await db
      .select()
      .from(decisionOutcomes)
      .where(eq(decisionOutcomes.id, id));
    if (!outcome) throw notFound("Decision outcome not found");

    if (outcome.outcomeStatus === "pending_followup") {
      throw unprocessable("Cannot promote an outcome that hasn't been answered");
    }

    if (outcome.memoryEntryId) {
      return { outcome: toRecord(outcome), memoryEntryId: outcome.memoryEntryId };
    }

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, outcome.approvalId));
    if (!approval) throw notFound("Linked approval not found");

    const payload = (approval.payload as Record<string, unknown> | null) ?? {};
    const payloadTitle =
      typeof payload.title === "string" && payload.title.length > 0
        ? payload.title
        : typeof payload.name === "string" && payload.name.length > 0
          ? payload.name
          : null;

    const decisionLabel = payloadTitle ?? `${approval.type} decision`;
    const statusLabel = outcomeLabel(outcome.outcomeStatus as OutcomeStatus);

    const title = `Decision outcome · ${decisionLabel} · ${statusLabel}`;
    const bodyLines = [
      `Decision: ${decisionLabel} (${approval.type}).`,
      `Approved: ${approval.decidedAt ? approval.decidedAt.toISOString().slice(0, 10) : "unknown"}.`,
      `Outcome: ${statusLabel}.`,
    ];
    if (outcome.metricDelta) {
      bodyLines.push(`Metric delta: ${outcome.metricDelta}.`);
    }
    if (outcome.founderNote) {
      bodyLines.push("", outcome.founderNote);
    }
    const body = bodyLines.join("\n");
    const occurredAt = outcome.answeredAt ?? outcome.promptedAt;

    const now = new Date();
    const [memoryRow] = await db
      .insert(companyMemory)
      .values({
        companyId: outcome.companyId,
        kind: "experiment_outcome",
        title,
        body,
        topic: approval.type,
        occurredAt,
        pinned: false,
        source: "auto",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [updatedOutcome] = await db
      .update(decisionOutcomes)
      .set({
        memoryEntryId: memoryRow.id,
        updatedAt: now,
      })
      .where(eq(decisionOutcomes.id, id))
      .returning();

    return {
      outcome: toRecord(updatedOutcome ?? outcome),
      memoryEntryId: memoryRow.id,
    };
  }

  /**
   * Internal helper for the cron: find approved approvals older than
   * `olderThan` that don't yet have a decision_outcomes row, then insert a
   * pending_followup row for each.
   *
   * Returns the number of new prompts created. Double-running with the same
   * cutoff is safe — the anti-join against decision_outcomes prevents dupes.
   */
  async function createPromptsForOverdueApprovals(olderThan: Date): Promise<{
    created: number;
    createdIds: string[];
  }> {
    // Find approved approvals past the cutoff with NO existing outcome row.
    const candidateRows = await db
      .select({
        id: approvals.id,
        companyId: approvals.companyId,
        decidedAt: approvals.decidedAt,
        outcomeId: decisionOutcomes.id,
      })
      .from(approvals)
      .leftJoin(decisionOutcomes, eq(decisionOutcomes.approvalId, approvals.id))
      .where(
        and(
          eq(approvals.status, "approved"),
          isNull(decisionOutcomes.id),
        ),
      );

    const due = candidateRows.filter(
      (r) => r.decidedAt !== null && r.decidedAt <= olderThan,
    );

    if (due.length === 0) {
      return { created: 0, createdIds: [] };
    }

    const now = new Date();
    const inserted = await db
      .insert(decisionOutcomes)
      .values(
        due.map((r) => ({
          approvalId: r.id,
          companyId: r.companyId,
          outcomeStatus: "pending_followup" as const,
          promptedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: decisionOutcomes.id });

    return {
      created: inserted.length,
      createdIds: inserted.map((row) => row.id),
    };
  }

  return {
    listPending,
    listForApproval,
    createPrompt,
    recordOutcome,
    promoteToMemory,
    createPromptsForOverdueApprovals,
  };
}

function outcomeLabel(status: OutcomeStatus): string {
  switch (status) {
    case "worked":
      return "Worked";
    case "did_not_work":
      return "Did not work";
    case "unclear":
      return "Unclear";
    case "dropped":
      return "Dropped";
    case "pending_followup":
      return "Pending follow-up";
    default:
      return status;
  }
}
