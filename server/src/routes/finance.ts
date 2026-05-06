import { Router } from "express";
import type { Db } from "@founderos/db";
import {
  pricingSimulateSchema,
  cashPlanInputSchema,
  financeScenarioInputSchema,
} from "@founderos/shared";
import { computeCockpitMetrics } from "../services/finance/cockpit.js";
import { runPricingSimulation } from "../services/finance/pricing-simulator.js";
import { computeChurnForecast } from "../services/finance/churn-forecast.js";
import { computeRunwayForecast } from "../services/finance/runway-forecast.js";
import { computeExperimentRoi } from "../services/finance/experiment-roi.js";
import { computeCashPlan } from "../services/finance/cash-planning.js";
import { runFinanceScenario } from "../services/agents/finance-scenario.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Finance routes (S5.1, S5.2) — cockpit + pricing simulator.
 *
 * GET  /api/companies/:companyId/finance/cockpit            → CockpitMetrics
 * POST /api/companies/:companyId/finance/pricing-simulate   → simulation
 *
 * All read-only against the events stream + S5.6/S5.9 manual inputs.
 * No materialized KPI snapshot in v1 — every load runs SQL fresh. For
 * most workspaces this is <50ms; if it gets slow with scale we add a
 * `company_kpi_snapshots` rolldown in v2.
 */
export function financeRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/finance/cockpit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const metrics = await computeCockpitMetrics(db, companyId);
    res.json(metrics);
  });

  router.get(
    "/companies/:companyId/finance/churn-forecast",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const forecast = await computeChurnForecast(db, companyId);
      res.json(forecast);
    },
  );

  router.get(
    "/companies/:companyId/finance/experiment-roi",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const rollup = await computeExperimentRoi(db, companyId);
      res.json(rollup);
    },
  );

  router.get(
    "/companies/:companyId/finance/runway",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const forecast = await computeRunwayForecast(db, companyId);
      // JSON.stringify drops Infinity → null; serialize explicitly so
      // the UI can render an "∞" affordance for cash-flow-positive months.
      res.json({
        ...forecast,
        bands: {
          conservative: serializeBand(forecast.bands.conservative),
          base: serializeBand(forecast.bands.base),
          optimistic: serializeBand(forecast.bands.optimistic),
        },
      });
    },
  );

  router.post(
    "/companies/:companyId/finance/cash-plan",
    validate(cashPlanInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const plan = await computeCashPlan(db, companyId, req.body);
      res.json(plan);
    },
  );

  router.post(
    "/companies/:companyId/finance/scenario",
    validate(financeScenarioInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      try {
        const result = await runFinanceScenario(
          db,
          companyId,
          req.body.question,
          req.body.maxSteps,
        );
        res.json(result);
      } catch (err) {
        if (err instanceof Error && err.message === "no_anthropic_key") {
          res.status(412).json({
            error: "no_anthropic_key",
            message:
              "Set an Anthropic API key under Instance → Providers to use scenario modeling.",
          });
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/finance/pricing-simulate",
    validate(pricingSimulateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      // Pull blended CAC from the cockpit (cheap if cockpit is cached at
      // the query layer; recomputed otherwise — fine for v1).
      const cockpit = await computeCockpitMetrics(db, companyId);
      const avgAcquisitionCostCents = cockpit.cac.cents ?? 0;

      try {
        const result = await runPricingSimulation(
          db,
          companyId,
          req.body.tierChanges,
          avgAcquisitionCostCents,
        );
        res.json(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("no_tiers_derived")) {
          res.status(422).json({
            error: "no_tiers_derived",
            message:
              "Workspace has no active subscriptions yet. Connect Stripe and capture at least one subscription event before simulating.",
          });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}

/**
 * JSON.stringify drops Infinity → null (RFC 8259 forbids non-finite
 * numbers). The UI needs to distinguish "we don't know" (null) from
 * "cash-flow-positive forever" (Infinity) — sentinel value 'infinite'
 * threads the meaning through.
 */
function serializeBand(band: {
  band: string;
  monthsRemaining: number;
  projectedCashOutDate: string | null;
  monthlyBalances: Array<{ month: number; cashCents: number; mrrCents: number; netBurnCents: number }>;
}) {
  return {
    band: band.band,
    monthsRemaining:
      band.monthsRemaining === Infinity ? "infinite" : band.monthsRemaining,
    projectedCashOutDate: band.projectedCashOutDate,
    monthlyBalances: band.monthlyBalances,
  };
}
