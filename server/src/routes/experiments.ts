/**
 * Experiments routes (S3.5).
 *
 *   GET   /api/companies/:companyId/experiments?status=&channel=
 *   POST  /api/companies/:companyId/experiments
 *   PATCH /api/companies/:companyId/experiments/:experimentId
 *
 * Tenant isolation: every route gates with assertCompanyAccess. PATCH also
 * verifies the experiment row's company_id matches the path companyId before
 * mutating, so a user with access to company A cannot edit an experiment in
 * company B by guessing its id.
 *
 * Sort order: GET defaults to ice_score DESC NULLS LAST. ice_score is a STORED
 * generated column, so the order is computed at write time and indexable —
 * no per-request math.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  experiments,
  EXPERIMENT_DEPARTMENTS,
  EXPERIMENT_STATUSES,
  EXPERIMENT_CHANNELS,
} from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

// Body validators — Zod parses + types the request body. expectedCacCents is
// accepted as a string OR number on the wire (JSON has no bigint type) and
// transformed into a JS bigint before insert. Drizzle's bigint mode 'bigint'
// expects a real JS bigint.
const bigintFromInput = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))
  .nullable()
  .optional();

const createExperimentSchema = z.object({
  hypothesis: z.string().min(1).max(2_000),
  department: z.enum(EXPERIMENT_DEPARTMENTS).optional(),
  channel: z.enum(EXPERIMENT_CHANNELS).nullable().optional(),
  expectedLiftPct: z.number().nullable().optional(),
  expectedCacCents: bigintFromInput,
  iceImpact: z.number().int().min(1).max(10),
  iceConfidence: z.number().int().min(1).max(10),
  iceEase: z.number().int().min(1).max(10),
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  nextMilestone: z.string().max(2_000).nullable().optional(),
});

const patchExperimentSchema = z.object({
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  actualLiftPct: z.number().nullable().optional(),
  completedAt: z
    .union([z.string().datetime(), z.date(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return v;
      return v instanceof Date ? v : new Date(v);
    }),
  nextMilestone: z.string().max(2_000).nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(EXPERIMENT_STATUSES).optional(),
  channel: z.enum(EXPERIMENT_CHANNELS).optional(),
});

export function experimentRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/experiments?status=&channel=
   * Sorted by ice_score DESC. NULLS LAST so unscored rows (shouldn't happen
   * since all components are NOT NULL, but defensive) sink to the bottom.
   */
  router.get("/companies/:companyId/experiments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsedQuery.error.flatten() });
      return;
    }
    const { status, channel } = parsedQuery.data;

    // Drizzle gotcha: chained .where(a).where(b) REPLACES the first where —
    // must compose with and(...). Build the predicate list, then pass once.
    const predicates = [eq(experiments.companyId, companyId)];
    if (status) predicates.push(eq(experiments.status, status));
    if (channel) predicates.push(eq(experiments.channel, channel));

    const rows = await db
      .select()
      .from(experiments)
      .where(and(...predicates))
      .orderBy(sql`${experiments.iceScore} DESC NULLS LAST`, desc(experiments.createdAt));

    res.json(rows);
  });

  /**
   * POST /api/companies/:companyId/experiments
   * Insert a new experiment. ice_score is computed by the DB (generated
   * column) — we never write it from app code.
   */
  router.post(
    "/companies/:companyId/experiments",
    validate(createExperimentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof createExperimentSchema>;

      const [created] = await db
        .insert(experiments)
        .values({
          companyId,
          hypothesis: body.hypothesis,
          department: body.department ?? "growth",
          channel: body.channel ?? null,
          expectedLiftPct: body.expectedLiftPct ?? null,
          expectedCacCents: body.expectedCacCents ?? null,
          iceImpact: body.iceImpact,
          iceConfidence: body.iceConfidence,
          iceEase: body.iceEase,
          status: body.status ?? "proposed",
          ownerAgentId: body.ownerAgentId ?? null,
          nextMilestone: body.nextMilestone ?? null,
        })
        .returning();

      res.status(201).json(created);
    },
  );

  /**
   * PATCH /api/companies/:companyId/experiments/:experimentId
   * Update status, actualLiftPct, completedAt, nextMilestone, or owner.
   * ICE components are immutable post-creation — that's an explicit design
   * choice (the score should reflect the prior at proposal time, not
   * retroactive optimism). Re-propose if scoring drifts.
   */
  router.patch(
    "/companies/:companyId/experiments/:experimentId",
    validate(patchExperimentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const experimentId = req.params.experimentId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof patchExperimentSchema>;

      // Existence + tenant guard in one query — cheaper than a separate
      // SELECT then UPDATE, and the UPDATE...WHERE is atomic.
      const updateValues: Record<string, unknown> = {};
      if (body.status !== undefined) updateValues.status = body.status;
      if (body.actualLiftPct !== undefined) updateValues.actualLiftPct = body.actualLiftPct;
      if (body.completedAt !== undefined) updateValues.completedAt = body.completedAt;
      if (body.nextMilestone !== undefined) updateValues.nextMilestone = body.nextMilestone;
      if (body.ownerAgentId !== undefined) updateValues.ownerAgentId = body.ownerAgentId;

      if (Object.keys(updateValues).length === 0) {
        // Nothing to change — return current row so the client gets a stable
        // shape regardless of whether anything changed.
        const [row] = await db
          .select()
          .from(experiments)
          .where(
            and(eq(experiments.id, experimentId), eq(experiments.companyId, companyId)),
          )
          .limit(1);
        if (!row) throw notFound("Experiment not found");
        res.json(row);
        return;
      }

      const updated = await db
        .update(experiments)
        .set(updateValues)
        .where(
          and(eq(experiments.id, experimentId), eq(experiments.companyId, companyId)),
        )
        .returning();

      if (updated.length === 0) {
        throw notFound("Experiment not found");
      }

      res.json(updated[0]);
    },
  );

  return router;
}
