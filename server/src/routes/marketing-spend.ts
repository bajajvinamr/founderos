import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { marketingSpend } from "@founderos/db";
import {
  createMarketingSpendSchema,
  updateMarketingSpendSchema,
  listMarketingSpendQuerySchema,
} from "@founderos/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Marketing spend ledger — manual ad-spend by channel + period (S5.6).
 *
 * GET    /api/companies/:companyId/finance/marketing-spend            list (channel + date filters)
 * POST   /api/companies/:companyId/finance/marketing-spend            create
 * PATCH  /api/companies/:companyId/finance/marketing-spend/:rowId     update
 * DELETE /api/companies/:companyId/finance/marketing-spend/:rowId     delete
 *
 * Row is per-period (typically per-month). Founder backfills 12 rows
 * for a year of LinkedIn spend if needed; the (companyId, channel,
 * periodStart) index supports the "all 2026 LinkedIn spend" lookup.
 */
export function marketingSpendRoutes(db: Db) {
  const router = Router();

  router.get(
    "/companies/:companyId/finance/marketing-spend",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const parsed = listMarketingSpendQuerySchema.parse(req.query);
      const filters = [eq(marketingSpend.companyId, companyId)];
      if (parsed.channel) {
        filters.push(eq(marketingSpend.channel, parsed.channel));
      }
      if (parsed.periodStart) {
        filters.push(gte(marketingSpend.periodStart, parsed.periodStart));
      }
      if (parsed.periodEnd) {
        filters.push(lte(marketingSpend.periodEnd, parsed.periodEnd));
      }

      const rows = await db
        .select()
        .from(marketingSpend)
        .where(and(...filters))
        .orderBy(desc(marketingSpend.periodStart));

      res.json(rows.map(serialize));
    },
  );

  router.post(
    "/companies/:companyId/finance/marketing-spend",
    validate(createMarketingSpendSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const actorLabel = formatActor(actor);

      const [row] = await db
        .insert(marketingSpend)
        .values({
          companyId,
          channel: req.body.channel,
          periodStart: req.body.periodStart,
          periodEnd: req.body.periodEnd,
          amountCents: req.body.amountCents,
          currency: req.body.currency ?? "USD",
          notes: req.body.notes ?? null,
          createdBy: actorLabel,
        })
        .returning();

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "marketing_spend.created",
        entityType: "marketing_spend",
        entityId: row.id,
        details: {
          channel: row.channel,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          amountCents: row.amountCents,
        },
      });

      res.status(201).json(serialize(row));
    },
  );

  router.patch(
    "/companies/:companyId/finance/marketing-spend/:rowId",
    validate(updateMarketingSpendSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const rowId = req.params.rowId as string;
      assertCompanyAccess(req, companyId);

      // Tenant scope: confirm the row belongs to this company before updating.
      // Without this check, a member of company A with a leaked rowId from
      // company B could update B's spend ledger.
      const [existing] = await db
        .select()
        .from(marketingSpend)
        .where(eq(marketingSpend.id, rowId))
        .limit(1);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Marketing spend row not found" });
        return;
      }

      const updates: Partial<typeof marketingSpend.$inferInsert> = {};
      if (req.body.channel !== undefined) updates.channel = req.body.channel;
      if (req.body.periodStart !== undefined)
        updates.periodStart = req.body.periodStart;
      if (req.body.periodEnd !== undefined)
        updates.periodEnd = req.body.periodEnd;
      if (req.body.amountCents !== undefined)
        updates.amountCents = req.body.amountCents;
      if (req.body.currency !== undefined) updates.currency = req.body.currency;
      if (req.body.notes !== undefined) updates.notes = req.body.notes;

      if (Object.keys(updates).length === 0) {
        res.json(serialize(existing));
        return;
      }

      const [updated] = await db
        .update(marketingSpend)
        .set(updates)
        .where(eq(marketingSpend.id, rowId))
        .returning();

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "marketing_spend.updated",
        entityType: "marketing_spend",
        entityId: updated.id,
        details: { keys: Object.keys(updates) },
      });

      res.json(serialize(updated));
    },
  );

  router.delete(
    "/companies/:companyId/finance/marketing-spend/:rowId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const rowId = req.params.rowId as string;
      assertCompanyAccess(req, companyId);

      const [existing] = await db
        .select()
        .from(marketingSpend)
        .where(eq(marketingSpend.id, rowId))
        .limit(1);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Marketing spend row not found" });
        return;
      }

      await db.delete(marketingSpend).where(eq(marketingSpend.id, rowId));

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "marketing_spend.deleted",
        entityType: "marketing_spend",
        entityId: rowId,
        details: {
          channel: existing.channel,
          periodStart: existing.periodStart,
        },
      });

      res.status(204).end();
    },
  );

  return router;
}

function serialize(row: typeof marketingSpend.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    channel: row.channel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountCents: Number(row.amountCents),
    currency: row.currency,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

function formatActor(actor: ReturnType<typeof getActorInfo>): string {
  if (actor.actorType === "agent" && actor.agentId) {
    return `agent:${actor.agentId}`;
  }
  return actor.actorId
    ? `${actor.actorType}:${actor.actorId}`
    : actor.actorType;
}
