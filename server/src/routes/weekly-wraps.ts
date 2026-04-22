/**
 * Wave 18B — Weekly Wrap routes.
 *
 *   GET    /api/companies/:companyId/weekly-wraps                   → list (newest first)
 *   GET    /api/companies/:companyId/weekly-wraps/:wrapId           → detail
 *   POST   /api/companies/:companyId/weekly-wraps/generate-now      → on-demand generate
 *
 * All routes gated by assertCompanyAccess. The POST is safe to call at any
 * time — the generator is idempotent per (companyId, weekEndingAt), so
 * repeated clicks in the same week return the same stored row.
 */

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { weeklyWraps } from "@founderos/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import {
  generateWeeklyWrap,
  type AnthropicCaller,
} from "../services/weekly-wrap-generator.js";

type WeeklyWrapRow = typeof weeklyWraps.$inferSelect;

function serialize(row: WeeklyWrapRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    weekEndingAt: row.weekEndingAt,
    narrative: row.narrative,
    highlights: row.highlights,
    metrics: row.metrics,
    deliveredToSlackAt: row.deliveredToSlackAt,
    deliveredToEmailAt: row.deliveredToEmailAt,
    slackChannelId: row.slackChannelId,
    createdAt: row.createdAt,
  };
}

export type WeeklyWrapRoutesOptions = {
  /** Dependency injection for tests — overrides the Anthropic call. */
  callAnthropic?: AnthropicCaller;
};

export function weeklyWrapRoutes(db: Db, options?: WeeklyWrapRoutesOptions) {
  const router = Router();

  router.get("/companies/:companyId/weekly-wraps", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(weeklyWraps)
      .where(eq(weeklyWraps.companyId, companyId))
      .orderBy(desc(weeklyWraps.weekEndingAt))
      .limit(50);

    res.json(rows.map(serialize));
  });

  router.get(
    "/companies/:companyId/weekly-wraps/:wrapId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const wrapId = req.params.wrapId as string;
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .select()
        .from(weeklyWraps)
        .where(
          and(eq(weeklyWraps.id, wrapId), eq(weeklyWraps.companyId, companyId)),
        )
        .limit(1);

      if (!row) throw notFound("Weekly wrap not found");
      res.json(serialize(row));
    },
  );

  router.post(
    "/companies/:companyId/weekly-wraps/generate-now",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const wrap = await generateWeeklyWrap(db, companyId, {
        callAnthropic: options?.callAnthropic,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: wrap.reused
          ? "weekly_wrap.generate_reused"
          : "weekly_wrap.generated",
        entityType: "weekly_wrap",
        entityId: wrap.storedWrapId,
        details: {
          weekEndingAt: wrap.weekEndingAt.toISOString(),
          reused: wrap.reused,
        },
      }).catch(() => {
        // Best-effort — don't fail the generate on a logging glitch.
      });

      res.status(wrap.reused ? 200 : 201).json({
        id: wrap.storedWrapId,
        weekEndingAt: wrap.weekEndingAt,
        narrative: wrap.narrative,
        highlights: wrap.highlights,
        metrics: wrap.metrics,
        reused: wrap.reused,
      });
    },
  );

  return router;
}
