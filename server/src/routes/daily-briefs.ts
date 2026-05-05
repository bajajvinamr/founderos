/**
 * daily-briefs routes (S3.3).
 *
 *   GET  /api/companies/:id/daily-briefs?forDate=&limit=&offset=
 *        Paginated list scoped via assertCompanyAccess. With ?forDate=
 *        returns the single brief for that date (200) or 404. Without it,
 *        returns up to `limit` recent briefs newest-first.
 *
 *   GET  /api/companies/:id/daily-briefs/:briefId
 *        Single fetch by id, scoped to the path companyId so a known briefId
 *        from one tenant cannot be read under another's path.
 *
 *   POST /api/companies/:id/daily-briefs/generate-now
 *        On-demand trigger — same idempotency contract as the cron. Re-runs
 *        for the same forDate return the existing row.
 *
 * Response shape mirrors the DB row + the parsed payload — `payload` is
 * already the typed DailyBriefPayload (jsonb is parsed by the driver).
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { dailyBriefs } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import {
  generateDailyBriefForCompany,
  type GenerateDailyBriefOptions,
} from "../jobs/daily-founder-brief.js";

type DailyBriefRow = typeof dailyBriefs.$inferSelect;

/**
 * Drizzle's `date` column returns a string ('yyyy-mm-dd') by default and the
 * `timestamp({ withTimezone: true })` columns return Date instances. We
 * normalize both to strings on the wire so the UI doesn't have to worry
 * about driver shape drift.
 */
function asDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function serialize(row: DailyBriefRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    forDate: asDateString(row.forDate),
    payload: row.payload,
    generatedAt: asIsoOrNull(row.generatedAt) ?? new Date().toISOString(),
    emailSentAt: asIsoOrNull(row.emailSentAt),
  };
}

const generateNowSchema = z
  .object({
    forDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "forDate must be yyyy-mm-dd")
      .optional(),
    timezone: z.string().max(64).optional(),
  })
  .optional();

export type DailyBriefRoutesOptions = {
  /** DI for tests — overrides the LLM call inside generateDailyBriefForCompany. */
  callAnthropic?: GenerateDailyBriefOptions["callAnthropic"];
  /** DI for tests — overrides the API key getter. */
  getAnthropicKey?: GenerateDailyBriefOptions["getAnthropicKey"];
};

export function dailyBriefRoutes(db: Db, options?: DailyBriefRoutesOptions) {
  const router = Router();

  /**
   * GET /api/companies/:id/daily-briefs?forDate=&limit=&offset=
   */
  router.get("/companies/:id/daily-briefs", async (req, res) => {
    const companyId = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const forDateRaw =
      typeof req.query.forDate === "string" ? req.query.forDate : null;
    if (forDateRaw !== null) {
      // ISO yyyy-mm-dd guard so we don't drop arbitrary strings into the
      // date column where Postgres parses them in surprising ways.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(forDateRaw)) {
        res
          .status(400)
          .json({ error: `invalid forDate (expected yyyy-mm-dd): ${forDateRaw}` });
        return;
      }
      const [row] = await db
        .select()
        .from(dailyBriefs)
        .where(
          and(
            eq(dailyBriefs.companyId, companyId),
            eq(dailyBriefs.forDate, forDateRaw),
          ),
        )
        .limit(1);
      if (!row) {
        throw notFound("Daily brief not found for that date");
      }
      res.json(serialize(row));
      return;
    }

    const limit = clampInt(req.query.limit, 30, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100_000);

    const rows = await db
      .select()
      .from(dailyBriefs)
      .where(eq(dailyBriefs.companyId, companyId))
      .orderBy(desc(dailyBriefs.forDate))
      .limit(limit)
      .offset(offset);

    res.json({
      briefs: rows.map(serialize),
      meta: { limit, offset, count: rows.length },
    });
  });

  /**
   * GET /api/companies/:id/daily-briefs/:briefId
   */
  router.get(
    "/companies/:id/daily-briefs/:briefId",
    async (req, res) => {
      const companyId = req.params.id as string;
      const briefId = req.params.briefId as string;
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .select()
        .from(dailyBriefs)
        .where(
          and(
            eq(dailyBriefs.id, briefId),
            eq(dailyBriefs.companyId, companyId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Daily brief not found");
      res.json(serialize(row));
    },
  );

  /**
   * POST /api/companies/:id/daily-briefs/generate-now
   *
   * Idempotent — re-runs for the same forDate return the existing row
   * (with HTTP 200) instead of regenerating. Fresh generation returns 201.
   */
  router.post(
    "/companies/:id/daily-briefs/generate-now",
    validate(generateNowSchema),
    async (req, res) => {
      const companyId = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const body = (req.body ?? {}) as
        | { forDate?: string; timezone?: string }
        | undefined;

      const result = await generateDailyBriefForCompany(db, companyId, {
        forDate: body?.forDate,
        timezone: body?.timezone,
        callAnthropic: options?.callAnthropic,
        getAnthropicKey: options?.getAnthropicKey,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: result.reused
          ? "daily_brief.generate_reused"
          : `daily_brief.generated_${result.source}`,
        entityType: "daily_brief",
        entityId: result.brief.id,
        details: {
          forDate: asDateString(result.brief.forDate),
          reused: result.reused,
          source: result.source,
        },
      }).catch(() => {
        // Best-effort — don't fail the generate on a logging glitch.
      });

      res.status(result.reused ? 200 : 201).json({
        ...serialize(result.brief),
        reused: result.reused,
        source: result.source,
        fallbackReason: result.fallbackReason,
      });
    },
  );

  return router;
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}
