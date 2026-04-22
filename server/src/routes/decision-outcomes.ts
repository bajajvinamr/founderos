/**
 * Decision outcomes routes.
 *
 *   GET   /api/companies/:companyId/decisions/pending-outcomes
 *   GET   /api/companies/:companyId/decisions/:approvalId/outcomes
 *   POST  /api/companies/:companyId/decisions/:approvalId/outcomes
 *   POST  /api/companies/:companyId/decisions/:approvalId/outcomes/:outcomeId/promote
 *
 * Tenant isolation: every route gates with assertCompanyAccess, and every
 * lookup verifies the underlying approval / outcome belongs to the path
 * companyId before returning or mutating anything.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { approvals, decisionOutcomes } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { decisionOutcomeService, type OutcomeStatus } from "../services/decision-outcomes.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

const recordOutcomeSchema = z.object({
  status: z.enum(["worked", "did_not_work", "unclear", "dropped"]),
  note: z.string().max(8_000).optional().nullable(),
  metric: z.string().max(500).optional().nullable(),
});

export function decisionOutcomeRoutes(db: Db) {
  const router = Router();
  const svc = decisionOutcomeService(db);

  /**
   * Guard: the approval exists AND belongs to the :companyId in the path.
   */
  async function assertApprovalInCompany(
    companyId: string,
    approvalId: string,
  ): Promise<void> {
    const [row] = await db
      .select({ id: approvals.id, companyId: approvals.companyId })
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
    if (!row) throw notFound("Approval not found for this company");
  }

  /**
   * Guard: the outcome exists, belongs to :approvalId, and to :companyId.
   */
  async function assertOutcomeInApproval(
    companyId: string,
    approvalId: string,
    outcomeId: string,
  ): Promise<void> {
    const [row] = await db
      .select({
        id: decisionOutcomes.id,
        companyId: decisionOutcomes.companyId,
        approvalId: decisionOutcomes.approvalId,
      })
      .from(decisionOutcomes)
      .where(
        and(
          eq(decisionOutcomes.id, outcomeId),
          eq(decisionOutcomes.approvalId, approvalId),
          eq(decisionOutcomes.companyId, companyId),
        ),
      );
    if (!row) throw notFound("Decision outcome not found");
  }

  /**
   * GET /api/companies/:companyId/decisions/pending-outcomes
   * List of outcomes still awaiting a founder answer. Used by the dashboard
   * banner and the dedicated follow-ups list view.
   */
  router.get("/companies/:companyId/decisions/pending-outcomes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const outcomes = await svc.listPending(companyId);
    res.json({ count: outcomes.length, outcomes });
  });

  /**
   * GET /api/companies/:companyId/decisions/:approvalId/outcomes
   */
  router.get(
    "/companies/:companyId/decisions/:approvalId/outcomes",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const approvalId = req.params.approvalId as string;
      assertCompanyAccess(req, companyId);
      await assertApprovalInCompany(companyId, approvalId);

      const outcomes = await svc.listForApproval(approvalId);
      res.json(outcomes);
    },
  );

  /**
   * POST /api/companies/:companyId/decisions/:approvalId/outcomes
   *
   * Records the founder's answer. If no pending_followup row exists yet
   * (founder answered before the cron fired), we create one first so the
   * answer has somewhere to live.
   */
  router.post(
    "/companies/:companyId/decisions/:approvalId/outcomes",
    validate(recordOutcomeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const approvalId = req.params.approvalId as string;
      assertCompanyAccess(req, companyId);
      await assertApprovalInCompany(companyId, approvalId);

      const existing = await svc.listForApproval(approvalId);
      const target = existing[0] ?? (await svc.createPrompt(approvalId));
      const recorded = await svc.recordOutcome(target.id, {
        status: req.body.status as Exclude<OutcomeStatus, "pending_followup">,
        note: req.body.note ?? null,
        metric: req.body.metric ?? null,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "decision_outcome.recorded",
        entityType: "decision_outcome",
        entityId: recorded.id,
        details: {
          approvalId,
          outcomeStatus: recorded.outcomeStatus,
          hasMetric: !!recorded.metricDelta,
        },
      });

      res.status(201).json(recorded);
    },
  );

  /**
   * POST /api/companies/:companyId/decisions/:approvalId/outcomes/:outcomeId/promote
   *
   * Promote an answered outcome into company_memory so future decisions have
   * the historical context. Idempotent.
   */
  router.post(
    "/companies/:companyId/decisions/:approvalId/outcomes/:outcomeId/promote",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const approvalId = req.params.approvalId as string;
      const outcomeId = req.params.outcomeId as string;
      assertCompanyAccess(req, companyId);
      await assertApprovalInCompany(companyId, approvalId);
      await assertOutcomeInApproval(companyId, approvalId, outcomeId);

      const { outcome, memoryEntryId } = await svc.promoteToMemory(outcomeId);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "decision_outcome.promoted_to_memory",
        entityType: "decision_outcome",
        entityId: outcome.id,
        details: { approvalId, memoryEntryId },
      });

      res.json({ outcome, memoryEntryId });
    },
  );

  return router;
}
