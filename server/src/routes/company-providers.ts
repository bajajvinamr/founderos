import { Router } from "express";
import { and, eq, gte, lt, sql as dsql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { agents, costEvents } from "@founderos/db";
import { assertCompanyAccess } from "./authz.js";

/**
 * Company-scoped provider overview.
 *
 * Aggregates:
 *   - agent count per adapter_type (e.g. 5× claude_local, 2× openai_api)
 *   - month-to-date cost per adapter_type (from cost_events)
 *
 * Feeds the Dashboard provider-overview widget so a founder can see at a
 * glance which providers their team actually runs on and what each one
 * costs this month.
 */
export function companyProviderRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/providers-overview", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const companyId = req.params.companyId;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [agentRows, costRows] = await Promise.all([
      db
        .select({
          adapterType: agents.adapterType,
          count: dsql<number>`count(*)::int`.as("count"),
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.adapterType),
      db
        .select({
          model: costEvents.model,
          provider: costEvents.provider,
          spendCents: dsql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`.as("spendCents"),
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
            lt(costEvents.occurredAt, nextMonth),
          ),
        )
        .groupBy(costEvents.model, costEvents.provider),
    ]);

    // Map adapter_type → family for the UI.
    const family = (adapter: string): "anthropic" | "openai" | "google" | "other" => {
      if (adapter === "claude_local" || adapter === "claude_api") return "anthropic";
      if (adapter === "codex_local" || adapter === "openai_api") return "openai";
      if (adapter === "gemini_local") return "google";
      return "other";
    };

    const adapters = agentRows.map((row) => ({
      adapterType: row.adapterType,
      family: family(row.adapterType),
      agentCount: Number(row.count),
    }));

    const spendByFamily = new Map<string, number>();
    for (const r of costRows) {
      const fam =
        r.provider === "anthropic" ? "anthropic"
        : r.provider === "openai" ? "openai"
        : r.provider === "google" || r.provider === "gemini" ? "google"
        : "other";
      spendByFamily.set(fam, (spendByFamily.get(fam) ?? 0) + Number(r.spendCents));
    }

    res.json({
      adapters,
      monthSpendByFamily: {
        anthropic: spendByFamily.get("anthropic") ?? 0,
        openai: spendByFamily.get("openai") ?? 0,
        google: spendByFamily.get("google") ?? 0,
        other: spendByFamily.get("other") ?? 0,
      },
      totalMonthSpendCents: Array.from(spendByFamily.values()).reduce((a, b) => a + b, 0),
    });
  });

  return router;
}
