import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companyFinancials } from "@founderos/db";
import { upsertFinanceSettingsSchema } from "@founderos/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Finance settings — singleton-per-company manual inputs
 * (S5.9 of Sprint 5 — Finance + scenario modeling).
 *
 * GET  /api/companies/:companyId/finance/settings → row or null
 * PUT  /api/companies/:companyId/finance/settings → upsert
 *
 * The row is unique on company_id; PUT performs an idempotent upsert
 * via Drizzle's onConflictDoUpdate so retries do not create duplicates.
 */
export function financeSettingsRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/finance/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(companyFinancials)
      .where(eq(companyFinancials.companyId, companyId))
      .limit(1);

    if (rows.length === 0) {
      res.json(null);
      return;
    }

    const row = rows[0];
    res.json({
      id: row.id,
      companyId: row.companyId,
      cashBalanceCents: Number(row.cashBalanceCents),
      monthlyBurnCents: Number(row.monthlyBurnCents),
      currency: row.currency,
      lastUpdatedAt: row.lastUpdatedAt.toISOString(),
      lastUpdatedBy: row.lastUpdatedBy,
      createdAt: row.createdAt.toISOString(),
    });
  });

  router.put(
    "/companies/:companyId/finance/settings",
    validate(upsertFinanceSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const actorLabel =
        actor.actorType === "agent" && actor.agentId
          ? `agent:${actor.agentId}`
          : actor.actorId
            ? `${actor.actorType}:${actor.actorId}`
            : actor.actorType;

      const now = new Date();
      const inserted = await db
        .insert(companyFinancials)
        .values({
          companyId,
          cashBalanceCents: req.body.cashBalanceCents,
          monthlyBurnCents: req.body.monthlyBurnCents,
          currency: req.body.currency ?? "USD",
          lastUpdatedAt: now,
          lastUpdatedBy: actorLabel,
        })
        .onConflictDoUpdate({
          target: companyFinancials.companyId,
          set: {
            cashBalanceCents: req.body.cashBalanceCents,
            monthlyBurnCents: req.body.monthlyBurnCents,
            currency: req.body.currency ?? "USD",
            lastUpdatedAt: now,
            lastUpdatedBy: actorLabel,
          },
        })
        .returning();

      const row = inserted[0];

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "finance.settings_upserted",
        entityType: "company_financials",
        entityId: row.id,
        details: {
          cashBalanceCents: row.cashBalanceCents,
          monthlyBurnCents: row.monthlyBurnCents,
          currency: row.currency,
        },
      });

      res.json({
        id: row.id,
        companyId: row.companyId,
        cashBalanceCents: Number(row.cashBalanceCents),
        monthlyBurnCents: Number(row.monthlyBurnCents),
        currency: row.currency,
        lastUpdatedAt: row.lastUpdatedAt.toISOString(),
        lastUpdatedBy: row.lastUpdatedBy,
        createdAt: row.createdAt.toISOString(),
      });
    },
  );

  return router;
}
