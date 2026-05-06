import { Router } from "express";
import type { Db } from "@founderos/db";
import { computeCockpitMetrics } from "../services/finance/cockpit.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Finance routes (S5.1) — revenue cockpit + downstream finance views.
 *
 * GET /api/companies/:companyId/finance/cockpit → CockpitMetrics
 *
 * Read-only; computed live from `events` (Stripe stream) +
 * `marketing_spend` (S5.6) + `company_financials` (S5.9). No materialized
 * KPI snapshot table in v1 — every cockpit load runs the SQL fresh.
 * For most workspaces this is <50ms; if it gets slow with scale we add
 * a `company_kpi_snapshots` rolldown in v2.
 */
export function financeRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/finance/cockpit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const metrics = await computeCockpitMetrics(db, companyId);
    res.json(metrics);
  });

  return router;
}
