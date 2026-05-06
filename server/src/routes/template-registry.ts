import { Router } from "express";
import { getTemplateRegistry } from "../services/workflows/template-registry.js";
import { assertBoard } from "./authz.js";

/**
 * Template registry (S6.5).
 *
 * GET /api/workflows/template-registry → NamedTemplateRegistryView
 *
 * Returns the catalogue of named PRD-flagship workflow templates with
 * their dept assignment, status (live | v1_1_planned), and trigger /
 * outcome summaries. Pure-data response — no per-tenant filtering, so
 * the only authz is "you must be on the board" (any logged-in user
 * sees the same registry).
 *
 * The companies'-own workflows live at /api/companies/:id/workflows
 * (existing route); this endpoint is for the "template gallery" UX
 * where the founder picks a flagship and the UI calls the workflows
 * route to instantiate a real workflow row.
 */
export function templateRegistryRoutes() {
  const router = Router();

  router.get("/workflows/template-registry", async (req, res) => {
    assertBoard(req);
    res.json(getTemplateRegistry());
  });

  return router;
}
