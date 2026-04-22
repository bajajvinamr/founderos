/**
 * Conversation routes — Wave 17E.
 *
 * Text-only wedge for the customer-conversation insight loop:
 *   POST   /api/companies/:companyId/conversations                  → create + kick extraction
 *   GET    /api/companies/:companyId/conversations                  → list (newest first)
 *   GET    /api/companies/:companyId/conversations/:convId          → detail w/ insights
 *   POST   /api/companies/:companyId/conversations/:convId/promote-insight
 *          Body: { index: number, pinned?: boolean, topic?: string | null }
 *          → writes the chosen extracted insight into company_memory as a founder_note.
 *
 * All routes are gated by assertCompanyAccess (board/agent tenancy).
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { conversations, companies, type ExtractedInsight } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity, companyMemoryService } from "../services/index.js";
import {
  conversationExtractorFromDb,
  type AnthropicCaller,
  type CompanyContext,
} from "../services/conversation-extractor.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Zod — request validators
// ---------------------------------------------------------------------------

const createConversationSchema = z.object({
  title: z.string().min(1).max(200),
  transcript: z.string().min(10).max(200_000),
  participants: z.array(z.string().min(1).max(80)).max(30).optional(),
  sourceKind: z
    .enum(["transcript_paste", "upload", "slack_import"])
    .optional()
    .default("transcript_paste"),
});

const promoteInsightSchema = z.object({
  index: z.number().int().min(0).max(50),
  pinned: z.boolean().optional().default(false),
  topic: z.string().max(100).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

type ConversationRow = typeof conversations.$inferSelect;

function toConversation(row: ConversationRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    participants: row.participants ?? [],
    sourceKind: row.sourceKind,
    transcript: row.transcript,
    extractionStatus: row.extractionStatus as "pending" | "complete" | "failed",
    extractedInsights: (row.extractedInsights ?? null) as ExtractedInsight[] | null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Factory — accepts an optional Anthropic caller override for tests.
// ---------------------------------------------------------------------------

export type ConversationRoutesOptions = {
  callAnthropic?: AnthropicCaller;
};

export function conversationRoutes(db: Db, options?: ConversationRoutesOptions) {
  const router = Router();
  const extractor = conversationExtractorFromDb(db, {
    callAnthropic: options?.callAnthropic,
  });
  const memory = companyMemoryService(db);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function loadCompanyContext(companyId: string): Promise<CompanyContext | undefined> {
    const [row] = await db
      .select({ name: companies.name, description: companies.description })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) return undefined;
    return {
      companyName: row.name,
      companyDescription: row.description ?? undefined,
    };
  }

  async function loadConversationInCompany(
    convId: string,
    companyId: string,
  ): Promise<ConversationRow | null> {
    const [row] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.companyId, companyId)));
    return row ?? null;
  }

  /**
   * Fire-and-forget extraction. Writes the result (or failure) back to the
   * conversation row. We don't block the POST on this because founders
   * expect an instant "saved" receipt and the LLM can take ~15-30s.
   */
  function runExtractionAsync(convId: string, companyId: string, transcript: string): void {
    void (async () => {
      try {
        const ctx = await loadCompanyContext(companyId);
        const result = await extractor.extractInsights(transcript, ctx);
        await db
          .update(conversations)
          .set({
            extractionStatus: "complete",
            extractedInsights: result.insights,
            completedAt: new Date(),
          })
          .where(eq(conversations.id, convId));
      } catch (err) {
        logger.error({ err, convId, companyId }, "conversation extraction failed");
        await db
          .update(conversations)
          .set({
            extractionStatus: "failed",
            completedAt: new Date(),
          })
          .where(eq(conversations.id, convId))
          .catch(() => {
            // Best-effort — nothing else we can do from a background task.
          });
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  /**
   * POST /api/companies/:companyId/conversations
   */
  router.post(
    "/companies/:companyId/conversations",
    validate(createConversationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .insert(conversations)
        .values({
          companyId,
          title: req.body.title,
          transcript: req.body.transcript,
          participants: req.body.participants ?? [],
          sourceKind: req.body.sourceKind,
          extractionStatus: "pending",
        })
        .returning();

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "conversation.created",
        entityType: "conversation",
        entityId: row.id,
        details: { sourceKind: row.sourceKind, title: row.title },
      });

      runExtractionAsync(row.id, companyId, row.transcript);

      res.status(201).json(toConversation(row));
    },
  );

  /**
   * GET /api/companies/:companyId/conversations
   */
  router.get("/companies/:companyId/conversations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    if (!Number.isFinite(limitRaw) || limitRaw <= 0 || limitRaw > 200) {
      throw badRequest("invalid 'limit' value");
    }

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.companyId, companyId))
      .orderBy(desc(conversations.createdAt))
      .limit(limitRaw);

    res.json(rows.map(toConversation));
  });

  /**
   * GET /api/companies/:companyId/conversations/:convId
   */
  router.get("/companies/:companyId/conversations/:convId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const convId = req.params.convId as string;
    assertCompanyAccess(req, companyId);

    const row = await loadConversationInCompany(convId, companyId);
    if (!row) {
      throw notFound("Conversation not found");
    }
    res.json(toConversation(row));
  });

  /**
   * POST /api/companies/:companyId/conversations/:convId/promote-insight
   *
   * Promotes insight[index] into company_memory as a founder_note. Returns
   * the created memory entry so the UI can link straight to it.
   */
  router.post(
    "/companies/:companyId/conversations/:convId/promote-insight",
    validate(promoteInsightSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      assertCompanyAccess(req, companyId);

      const row = await loadConversationInCompany(convId, companyId);
      if (!row) {
        throw notFound("Conversation not found");
      }

      const insights = (row.extractedInsights ?? []) as ExtractedInsight[];
      const insight = insights[req.body.index];
      if (!insight) {
        throw badRequest("Insight not found at that index");
      }

      const body =
        `${insight.content}\n\n` +
        `> "${insight.source_quote}"\n\n` +
        `Source: conversation "${row.title}" · confidence ${Math.round(insight.confidence * 100)}%`;

      const entry = await memory.create(companyId, {
        kind: "founder_note",
        title: insight.title,
        body,
        topic: req.body.topic ?? null,
        pinned: req.body.pinned ?? false,
        source: "manual",
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "conversation.insight_promoted",
        entityType: "company_memory",
        entityId: entry.id,
        details: {
          conversationId: convId,
          insightIndex: req.body.index,
          title: insight.title,
        },
      });

      res.status(201).json(entry);
    },
  );

  return router;
}
