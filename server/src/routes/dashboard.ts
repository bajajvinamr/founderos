import { Router } from "express";
import type { Db } from "@founderos/db";
import { dashboardService } from "../services/dashboard.js";
import { generateYesterdaySummary } from "../services/yesterday-summary.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  // BL-022 / P8.b — "What we shipped yesterday" Haiku-generated widget.
  // Returns 3-5 founder-language outcomes from completed issues in the
  // last 24h. Per-tenant per-day in-memory cache lives inside the
  // service module; the route is a thin pass-through that enforces
  // tenant access and serializes the result. Empty completions return
  // `{ outcomes: [], source: 'empty' }` (200, not 204 — the widget
  // renders its own empty-state when `outcomes.length === 0`).
  router.get("/companies/:companyId/dashboard/yesterday", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await generateYesterdaySummary(db, companyId);
    res.json(summary);
  });

  return router;
}
