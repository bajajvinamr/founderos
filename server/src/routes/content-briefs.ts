/**
 * content-briefs routes (S4.1).
 *
 *   GET   /api/companies/:companyId/content-briefs?status=&limit=&offset=
 *         Paginated list newest-first, optionally filtered by status.
 *
 *   GET   /api/companies/:companyId/content-briefs/:briefId
 *         Single fetch scoped to the path companyId — a known briefId from
 *         one tenant cannot be read under another's path (row-level check).
 *
 *   POST  /api/companies/:companyId/content-briefs
 *         Create a new brief in 'draft' status.
 *
 *   PATCH /api/companies/:companyId/content-briefs/:briefId
 *         Update mutable fields (title, thesis, audience, angle, keywords,
 *         notesMarkdown, scheduledFor). Status is NOT accepted here — use
 *         the transition endpoint.
 *
 *   POST  /api/companies/:companyId/content-briefs/:briefId/transition
 *         Explicit status transition with valid-state-machine check.
 *
 * Tenant isolation: every route gates with assertCompanyAccess. PATCH and
 * transition also verify the row's company_id matches the path param so a
 * user with access to company A cannot mutate a brief in company B.
 *
 * Drizzle and() invariant: NEVER chain .where(a).where(b); always use
 * and(eq(...), eq(...)) — the chained form silently replaces the first
 * clause. See vinamr-invariants and TC-3 hubspot fix (60a287c).
 */

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { contentBriefs } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import {
  createContentBriefSchema,
  updateContentBriefSchema,
  transitionContentBriefSchema,
  CONTENT_BRIEF_STATUSES,
  type CreateContentBrief,
  type UpdateContentBrief,
  type TransitionContentBrief,
} from "@founderos/shared";

/**
 * Valid status transitions for the brief state machine.
 * Stored as a map from current status → set of allowed next statuses.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["researching", "drafting"],
  researching: ["drafting"],
  drafting: ["review"],
  review: ["scheduled", "draft"],   // 'draft' allows kicking back for revision
  scheduled: ["review", "published"],
  published: [],                    // terminal; no forward transitions
};

type ContentBriefRow = typeof contentBriefs.$inferSelect;

function serializeBrief(row: ContentBriefRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    thesis: row.thesis,
    audience: row.audience ?? null,
    angle: row.angle ?? null,
    keywords: row.keywords ?? null,
    notesMarkdown: row.notesMarkdown ?? null,
    status: row.status,
    scheduledFor:
      row.scheduledFor instanceof Date
        ? row.scheduledFor.toISOString()
        : row.scheduledFor ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

export function contentBriefRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/content-briefs?status=&limit=&offset=
   */
  router.get("/companies/:companyId/content-briefs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const statusRaw =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (
      statusRaw !== undefined &&
      !(CONTENT_BRIEF_STATUSES as readonly string[]).includes(statusRaw)
    ) {
      res.status(400).json({ error: `invalid status: ${statusRaw}` });
      return;
    }

    const limit = clampInt(req.query.limit, 30, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100_000);

    const rows = await db
      .select()
      .from(contentBriefs)
      .where(
        statusRaw !== undefined
          ? and(
              eq(contentBriefs.companyId, companyId),
              // cast: statusRaw is validated above against CONTENT_BRIEF_STATUSES
              sql`${contentBriefs.status} = ${statusRaw}`,
            )
          : eq(contentBriefs.companyId, companyId),
      )
      // Council 2026-05-06 — tiebreaker on id when two briefs land in the
      // same now() microsecond (test race). Without this the test "newest
      // first" assertion is non-deterministic across embedded-pg ticks.
      // Sort by createdAt DESC then id DESC so insertion order is stable
      // within the same timestamp bucket.
      .orderBy(desc(contentBriefs.createdAt), desc(contentBriefs.id))
      .limit(limit)
      .offset(offset);

    res.json({
      briefs: rows.map(serializeBrief),
      meta: { limit, offset, count: rows.length },
    });
  });

  /**
   * GET /api/companies/:companyId/content-briefs/:briefId
   */
  router.get(
    "/companies/:companyId/content-briefs/:briefId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const briefId = req.params.briefId as string;
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .select()
        .from(contentBriefs)
        .where(
          and(
            eq(contentBriefs.id, briefId),
            eq(contentBriefs.companyId, companyId),
          ),
        )
        .limit(1);

      if (!row) throw notFound("Content brief not found");
      res.json(serializeBrief(row));
    },
  );

  /**
   * POST /api/companies/:companyId/content-briefs
   */
  router.post(
    "/companies/:companyId/content-briefs",
    validate(createContentBriefSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as CreateContentBrief;

      const [row] = await db
        .insert(contentBriefs)
        .values({
          companyId,
          title: body.title,
          thesis: body.thesis,
          audience: body.audience ?? null,
          angle: body.angle ?? null,
          keywords: body.keywords ?? null,
          notesMarkdown: body.notesMarkdown ?? null,
          status: "draft",
          scheduledFor: body.scheduledFor ?? null,
        })
        .returning();

      res.status(201).json(serializeBrief(row!));
    },
  );

  /**
   * PATCH /api/companies/:companyId/content-briefs/:briefId
   */
  router.patch(
    "/companies/:companyId/content-briefs/:briefId",
    validate(updateContentBriefSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const briefId = req.params.briefId as string;
      assertCompanyAccess(req, companyId);

      // Verify the row belongs to this company before mutating.
      const [existing] = await db
        .select({ id: contentBriefs.id })
        .from(contentBriefs)
        .where(
          and(
            eq(contentBriefs.id, briefId),
            eq(contentBriefs.companyId, companyId),
          ),
        )
        .limit(1);

      if (!existing) throw notFound("Content brief not found");

      const body = req.body as UpdateContentBrief;

      const updateFields: Partial<typeof contentBriefs.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.title !== undefined) updateFields.title = body.title;
      if (body.thesis !== undefined) updateFields.thesis = body.thesis;
      if ("audience" in body) updateFields.audience = body.audience ?? null;
      if ("angle" in body) updateFields.angle = body.angle ?? null;
      if ("keywords" in body) updateFields.keywords = body.keywords ?? null;
      if ("notesMarkdown" in body)
        updateFields.notesMarkdown = body.notesMarkdown ?? null;
      if ("scheduledFor" in body)
        updateFields.scheduledFor = body.scheduledFor ?? null;

      const [updated] = await db
        .update(contentBriefs)
        .set(updateFields)
        .where(
          and(
            eq(contentBriefs.id, briefId),
            eq(contentBriefs.companyId, companyId),
          ),
        )
        .returning();

      res.json(serializeBrief(updated!));
    },
  );

  /**
   * POST /api/companies/:companyId/content-briefs/:briefId/transition
   *
   * Enforces the status state machine. Rejected transitions return 422
   * (Unprocessable Entity) with the allowed next states listed.
   */
  router.post(
    "/companies/:companyId/content-briefs/:briefId/transition",
    validate(transitionContentBriefSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const briefId = req.params.briefId as string;
      assertCompanyAccess(req, companyId);

      const { status: targetStatus } = req.body as TransitionContentBrief;

      const [existing] = await db
        .select({ id: contentBriefs.id, status: contentBriefs.status })
        .from(contentBriefs)
        .where(
          and(
            eq(contentBriefs.id, briefId),
            eq(contentBriefs.companyId, companyId),
          ),
        )
        .limit(1);

      if (!existing) throw notFound("Content brief not found");

      const allowed = VALID_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(targetStatus)) {
        throw badRequest(
          `Cannot transition from '${existing.status}' to '${targetStatus}'. Allowed: [${allowed.join(", ") || "none"}]`,
        );
      }

      const [updated] = await db
        .update(contentBriefs)
        .set({ status: targetStatus, updatedAt: new Date() })
        .where(
          and(
            eq(contentBriefs.id, briefId),
            eq(contentBriefs.companyId, companyId),
          ),
        )
        .returning();

      res.json(serializeBrief(updated!));
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

