/**
 * content-drafts routes (S4.2).
 *
 *   POST /api/companies/:companyId/content-briefs/:briefId/generate
 *        Kicks off multi-format content generation for the given brief.
 *        Returns immediately with the result (success or error with per-format
 *        error payloads). Generation is synchronous in v1 — client should
 *        expect ~15-30s response time.
 *
 *   GET  /api/companies/:companyId/content-drafts
 *        List all drafts for the company (newest first), optionally filtered
 *        by ?briefId= or ?format= or ?status=.
 *
 *   GET  /api/companies/:companyId/content-drafts/:draftId
 *        Single draft fetch scoped to the path companyId — row-level tenant
 *        check so a known draftId from another company returns 404.
 *
 *   PATCH /api/companies/:companyId/content-drafts/:draftId
 *         Update status (drafted → edited → approved → published | discarded)
 *         and/or publishedToUrl.
 *
 * Tenant isolation:
 *   Every route gates with assertCompanyAccess.
 *   The generate endpoint uses assertStrictCompanyMembership because it
 *   triggers an LLM call (an action with cost implications, not just a read).
 *   Draft reads use assertCompanyAccess (read-only, no side effects).
 *
 * Drizzle and() invariant:
 *   NEVER chain .where(a).where(b) — always and(eq(...), eq(...)).
 */

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  contentDrafts,
  CONTENT_DRAFT_FORMATS,
  CONTENT_DRAFT_STATUSES,
} from "@founderos/db";
import { validate } from "../middleware/validate.js";
import {
  assertCompanyAccess,
  assertStrictCompanyMembership,
  getActorInfo,
} from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import {
  generateContentSchema,
  updateContentDraftSchema,
  type GenerateContent,
  type UpdateContentDraft,
} from "@founderos/shared";
import { runContentGenerator } from "../services/agents/content-generator.js";
import {
  getAttribution,
  generateAttributionUtm,
} from "../services/content-attribution.js";
import { instanceApiKeysService } from "../services/instance-api-keys.js";

type ContentDraftRow = typeof contentDrafts.$inferSelect;

function serializeDraft(row: ContentDraftRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    briefId: row.briefId,
    format: row.format,
    payload: row.payload,
    status: row.status,
    publishedAt:
      row.publishedAt instanceof Date
        ? row.publishedAt.toISOString()
        : row.publishedAt ?? null,
    publishedToUrl: row.publishedToUrl ?? null,
    attributionUtm: row.attributionUtm ?? null,
    generatedByRunId: row.generatedByRunId ?? null,
    generationError: row.generationError ?? null,
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

export function contentDraftRoutes(db: Db) {
  const router = Router();

  /**
   * POST /api/companies/:companyId/content-briefs/:briefId/generate
   *
   * Triggers multi-format generation. Strict membership required — LLM calls
   * have cost implications, instance-admin "visibility" does not grant this.
   */
  router.post(
    "/companies/:companyId/content-briefs/:briefId/generate",
    validate(generateContentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const briefId = req.params.briefId as string;

      // Strict membership: LLM call has cost + side effects.
      assertStrictCompanyMembership(req, companyId);

      const body = req.body as GenerateContent;
      const actor = getActorInfo(req);

      // API key resolution: read directly from the encrypted vault on every
      // call. The previous "bridge into process.env at boot" pattern was
      // dropped in S8 P0.1 Phase 1B (council R1 C2: per-tenant collision +
      // write race on the shared global). `getDecrypted` is the authoritative
      // path; the plaintext flows only through this request scope.
      const apiKeys = instanceApiKeysService(db);
      const decrypted = await apiKeys.getDecrypted("anthropic", "api");
      const apiKey = decrypted?.trim();
      if (!apiKey) {
        res.status(422).json({
          error:
            "No Anthropic API key configured. Add one under Instance → Providers.",
        });
        return;
      }

      const result = await runContentGenerator(
        db,
        {
          companyId,
          briefId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
        },
        {
          apiKey,
          workflowId: body.workflowId ?? null,
        },
      );

      if (!result.ok) {
        // 422 so the client can distinguish "generation attempted but LLM failed"
        // from 404 (brief not found) or 500 (unexpected crash).
        res.status(422).json({
          error: result.reason,
          runId: result.runId,
          briefId: result.briefId,
          drafts: result.drafts,
        });
        return;
      }

      res.status(200).json({
        runId: result.runId,
        briefId: result.briefId,
        drafts: result.drafts,
      });
    },
  );

  /**
   * GET /api/companies/:companyId/content-drafts
   * Optional query params: briefId, format, status, limit, offset
   */
  router.get("/companies/:companyId/content-drafts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const briefIdFilter =
      typeof req.query.briefId === "string" ? req.query.briefId : undefined;
    const formatRaw =
      typeof req.query.format === "string" ? req.query.format : undefined;
    const statusRaw =
      typeof req.query.status === "string" ? req.query.status : undefined;

    if (
      formatRaw !== undefined &&
      !(CONTENT_DRAFT_FORMATS as readonly string[]).includes(formatRaw)
    ) {
      res.status(400).json({ error: `invalid format: ${formatRaw}` });
      return;
    }
    if (
      statusRaw !== undefined &&
      !(CONTENT_DRAFT_STATUSES as readonly string[]).includes(statusRaw)
    ) {
      res.status(400).json({ error: `invalid status: ${statusRaw}` });
      return;
    }

    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100_000);

    // Build WHERE conditions — always scoped to companyId.
    // NEVER chain .where(a).where(b): use and(eq, eq) per vinamr-invariants.
    // Use sql`` template for the typed enum columns (format, status) since
    // the raw query string is `string` but the column is typed as a union —
    // values are validated against the allow-list above before reaching here.
    const conditions = [eq(contentDrafts.companyId, companyId)];
    if (briefIdFilter) conditions.push(eq(contentDrafts.briefId, briefIdFilter));
    if (formatRaw)
      conditions.push(sql`${contentDrafts.format} = ${formatRaw}`);
    if (statusRaw)
      conditions.push(sql`${contentDrafts.status} = ${statusRaw}`);

    const rows = await db
      .select()
      .from(contentDrafts)
      .where(and(...(conditions as Parameters<typeof and>)))
      .orderBy(desc(contentDrafts.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      drafts: rows.map(serializeDraft),
      meta: { limit, offset, count: rows.length },
    });
  });

  /**
   * GET /api/companies/:companyId/content-drafts/:draftId
   */
  router.get(
    "/companies/:companyId/content-drafts/:draftId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const draftId = req.params.draftId as string;
      assertCompanyAccess(req, companyId);

      // and(eq, eq) — not chained .where
      const [row] = await db
        .select()
        .from(contentDrafts)
        .where(
          and(
            eq(contentDrafts.id, draftId),
            eq(contentDrafts.companyId, companyId),
          ),
        )
        .limit(1);

      if (!row) throw notFound("Content draft not found");
      res.json(serializeDraft(row));
    },
  );

  /**
   * PATCH /api/companies/:companyId/content-drafts/:draftId
   */
  router.patch(
    "/companies/:companyId/content-drafts/:draftId",
    validate(updateContentDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const draftId = req.params.draftId as string;
      assertCompanyAccess(req, companyId);

      // Verify ownership before mutating.
      const [existing] = await db
        .select({
          id: contentDrafts.id,
          format: contentDrafts.format,
          status: contentDrafts.status,
        })
        .from(contentDrafts)
        .where(
          and(
            eq(contentDrafts.id, draftId),
            eq(contentDrafts.companyId, companyId),
          ),
        )
        .limit(1);

      if (!existing) throw notFound("Content draft not found");

      const body = req.body as UpdateContentDraft;

      if (Object.keys(body).length === 0) {
        throw badRequest("No fields to update");
      }

      const updateFields: Partial<typeof contentDrafts.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.status !== undefined) updateFields.status = body.status;
      if ("publishedToUrl" in body)
        updateFields.publishedToUrl = body.publishedToUrl ?? null;

      if (body.status === "published") {
        updateFields.publishedAt = new Date();
        // Auto-generate attributionUtm on publish (S4.3)
        updateFields.attributionUtm = generateAttributionUtm(
          draftId,
          existing.format,
        );
      }

      const [updated] = await db
        .update(contentDrafts)
        .set(updateFields)
        .where(
          and(
            eq(contentDrafts.id, draftId),
            eq(contentDrafts.companyId, companyId),
          ),
        )
        .returning();

      res.json(serializeDraft(updated!));
    },
  );

  /**
   * GET /api/companies/:companyId/content-drafts/:draftId/attribution
   * Returns attribution metrics for the draft over the last 30 days.
   */
  router.get(
    "/companies/:companyId/content-drafts/:draftId/attribution",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const draftId = req.params.draftId as string;
      assertCompanyAccess(req, companyId);

      // Verify draft exists and belongs to this company
      const [draft] = await db
        .select({
          id: contentDrafts.id,
          attributionUtm: contentDrafts.attributionUtm,
          status: contentDrafts.status,
        })
        .from(contentDrafts)
        .where(
          and(
            eq(contentDrafts.id, draftId),
            eq(contentDrafts.companyId, companyId),
          ),
        )
        .limit(1);

      if (!draft) throw notFound("Content draft not found");

      // Fetch attribution metrics
      const metrics = await getAttribution(
        db,
        draftId,
        companyId,
        draft.attributionUtm ?? "",
      );

      res.json(metrics);
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
