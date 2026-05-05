/**
 * insights routes — department-agent recommendation surface (S3.1).
 *
 *   GET    /api/companies/:id/insights?kind=&status=&department=&limit=&offset=
 *          Paginated list scoped via assertCompanyAccess. Filters are
 *          conjunctive (.where(and(...)) — chained .where() calls REPLACE
 *          rather than AND in Drizzle, see FounderOS invariants).
 *
 *   POST   /api/companies/:id/insights
 *          Zod-validated body. The service is the only writer; CHECK
 *          constraints in the migration are the runtime backstop for any
 *          caller that bypasses the typed path.
 *
 *   PATCH  /api/companies/:id/insights/:insightId
 *          Updates status (and optional outcomeNote). Enforces the
 *          one-way-door rule: status='dismissed' cannot transition back to
 *          'open' — founders must surface a new insight rather than
 *          re-litigating a dismissed one. The DB allows it; the API forbids
 *          it so the audit trail stays clean.
 *
 * Tenant isolation: every route gates with assertCompanyAccess + every
 * lookup re-checks companyId on the row before mutating, so a known
 * insightId from one tenant cannot be mutated under another tenant's path.
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  insights,
  INSIGHT_DEPARTMENTS,
  INSIGHT_KINDS,
  INSIGHT_STATUSES,
  type InsightDepartment,
  type InsightKind,
  type InsightStatus,
} from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { conflict, notFound } from "../errors.js";

// ── Zod schemas ──────────────────────────────────────────────────────────

const departmentSchema = z.enum(INSIGHT_DEPARTMENTS);
const kindSchema = z.enum(INSIGHT_KINDS);
const statusSchema = z.enum(INSIGHT_STATUSES);

const createInsightSchema = z.object({
  department: departmentSchema,
  kind: kindSchema,
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
  confidence: z.number().min(0).max(1),
  recommendation: z.string().max(20_000).optional().nullable(),
  evidence: z.unknown(),
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .nullable(),
});

/**
 * PATCH allows status (always) and outcomeNote (optional). We deliberately
 * don't expose body/title mutation through the API — insights are a write-
 * once surface; agents must emit a new row to revise.
 */
const patchInsightSchema = z.object({
  status: statusSchema,
  outcomeNote: z.string().max(20_000).optional().nullable(),
});

// ── Router ──────────────────────────────────────────────────────────────

export function insightRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:id/insights?kind=&status=&department=&limit=&offset=
   * Returns newest-first within the (company_id, kind, created_at DESC) idx
   * when kind is supplied; otherwise falls back to created_at DESC.
   */
  router.get("/companies/:id/insights", async (req, res) => {
    const companyId = req.params.id as string;
    assertCompanyAccess(req, companyId);

    // Filters — return 400 on a typo so callers don't silently get an
    // empty list. The CHECK constraint catches the same typo at write
    // time; this catches it at read time before any DB hit.
    const kindRaw = typeof req.query.kind === "string" ? req.query.kind : null;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : null;
    const departmentRaw = typeof req.query.department === "string" ? req.query.department : null;

    let kind: InsightKind | null = null;
    if (kindRaw !== null) {
      const parsed = kindSchema.safeParse(kindRaw);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid kind: ${kindRaw}` });
        return;
      }
      kind = parsed.data;
    }

    let status: InsightStatus | null = null;
    if (statusRaw !== null) {
      const parsed = statusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid status: ${statusRaw}` });
        return;
      }
      status = parsed.data;
    }

    let department: InsightDepartment | null = null;
    if (departmentRaw !== null) {
      const parsed = departmentSchema.safeParse(departmentRaw);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid department: ${departmentRaw}` });
        return;
      }
      department = parsed.data;
    }

    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100_000);

    // CRITICAL: chained .where() REPLACES the previous predicate in
    // Drizzle — the only way to AND filters is .where(and(...)). The
    // single-call form with `and()` keeps the predicate compositional.
    const filters = [eq(insights.companyId, companyId)];
    if (kind) filters.push(eq(insights.kind, kind));
    if (status) filters.push(eq(insights.status, status));
    if (department) filters.push(eq(insights.department, department));

    const rows = await db
      .select()
      .from(insights)
      .where(and(...filters))
      .orderBy(desc(insights.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      insights: rows,
      meta: { limit, offset, count: rows.length },
    });
  });

  /**
   * POST /api/companies/:id/insights
   * Creates a new insight. The CHECK constraints are belt-and-braces — Zod
   * already rejects out-of-range department/kind/status/confidence, but a
   * raw SQL writer would still hit the DB layer.
   */
  router.post(
    "/companies/:id/insights",
    validate(createInsightSchema),
    async (req, res) => {
      const companyId = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const parsed = req.body as z.infer<typeof createInsightSchema>;

      const [row] = await db
        .insert(insights)
        .values({
          companyId,
          department: parsed.department,
          kind: parsed.kind,
          title: parsed.title,
          body: parsed.body,
          confidence: parsed.confidence,
          recommendation: parsed.recommendation ?? null,
          evidence: parsed.evidence ?? {},
          expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        })
        .returning();

      res.status(201).json(row);
    },
  );

  /**
   * PATCH /api/companies/:id/insights/:insightId
   * Status transitions only. Enforces no-reopen-from-dismissed.
   */
  router.patch(
    "/companies/:id/insights/:insightId",
    validate(patchInsightSchema),
    async (req, res) => {
      const companyId = req.params.id as string;
      const insightId = req.params.insightId as string;
      assertCompanyAccess(req, companyId);

      const parsed = req.body as z.infer<typeof patchInsightSchema>;

      // Fetch existing row scoped to companyId — prevents cross-tenant
      // mutation via a known insightId. Same predicate-AND'ing rule:
      // .where(and(...)).
      const [existing] = await db
        .select({
          id: insights.id,
          status: insights.status,
        })
        .from(insights)
        .where(
          and(eq(insights.id, insightId), eq(insights.companyId, companyId)),
        );

      if (!existing) {
        throw notFound("Insight not found");
      }

      // One-way door: dismissed → open is the only forbidden transition.
      // Other transitions (acted_on → open, expired → open) are allowed —
      // a founder can revisit an action they took; a dismissal is a
      // deliberate "no, never" that should not be re-litigated through
      // the UI. Bypass via direct SQL during incident response is fine.
      if (existing.status === "dismissed" && parsed.status === "open") {
        throw conflict(
          "Cannot reopen a dismissed insight; emit a new insight instead",
        );
      }

      const [updated] = await db
        .update(insights)
        .set({
          status: parsed.status,
          outcomeNote: parsed.outcomeNote ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(insights.id, insightId), eq(insights.companyId, companyId)),
        )
        .returning();

      res.json(updated);
    },
  );

  return router;
}

// ── helpers ──────────────────────────────────────────────────────────────

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
