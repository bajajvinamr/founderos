import { Router } from "express";
import type { Db } from "@founderos/db";
import { generateAgentReviewSchema, createManualAgentReviewSchema } from "@founderos/shared";
import { validate } from "../middleware/validate.js";
import { agentReviewsService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";

export function agentReviewRoutes(db: Db) {
  const router = Router();
  const reviews = agentReviewsService(db);

  /**
   * GET /api/companies/:companyId/agent-reviews
   * List reviews for a company, optionally filtered by agentId.
   * ?agentId=...&limit=...
   */
  router.get("/companies/:companyId/agent-reviews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agentId = req.query.agentId as string | undefined;
    const limitRaw = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limitRaw) || limitRaw <= 0 || limitRaw > 200)) {
      throw badRequest("invalid 'limit' value");
    }

    const results = await reviews.list(companyId, { agentId, limit: limitRaw });
    res.json(results);
  });

  /**
   * GET /api/companies/:companyId/agents/:agentId/reviews/latest
   * Get the most recent review for a specific agent.
   */
  router.get("/companies/:companyId/agents/:agentId/reviews/latest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);

    const review = await reviews.getLatest(agentId);
    if (!review) {
      res.status(404).json({ error: "No review found for this agent" });
      return;
    }
    res.json(review);
  });

  /**
   * POST /api/companies/:companyId/agents/:agentId/reviews/generate
   * Trigger auto-generation (or refresh) of a monthly review.
   * Body: { monthOf: 'YYYY-MM-01' }
   */
  router.post(
    "/companies/:companyId/agents/:agentId/reviews/generate",
    validate(generateAgentReviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);

      const review = await reviews.generateMonthlyReview(agentId, req.body.monthOf);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId,
        action: "agent.review_generated",
        entityType: "agent_review",
        entityId: review.id,
        details: { monthOf: req.body.monthOf, recommendation: review.recommendation },
      });

      res.json(review);
    },
  );

  /**
   * POST /api/companies/:companyId/agents/:agentId/reviews
   * Create a manual review entry.
   * Body: { summaryMarkdown, recommendation, rationale, monthOf? }
   */
  router.post(
    "/companies/:companyId/agents/:agentId/reviews",
    validate(createManualAgentReviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);

      const review = await reviews.createManual(agentId, {
        summaryMarkdown: req.body.summaryMarkdown,
        recommendation: req.body.recommendation,
        rationale: req.body.rationale,
        monthOf: req.body.monthOf,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId,
        action: "agent.review_created",
        entityType: "agent_review",
        entityId: review.id,
        details: { monthOf: review.monthOf, source: "manual", recommendation: review.recommendation },
      });

      res.status(201).json(review);
    },
  );

  return router;
}
