/**
 * Routes for reading cached integration data and triggering manual re-syncs.
 *
 * GET  /api/companies/:companyId/integration-data?kind=<kind>
 *   → returns the stored payload + fetchedAt, or 404 if none
 *
 * POST /api/companies/:companyId/integrations/:id/sync
 *   → runs syncPostHog synchronously and returns the result
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrationData, integrations } from "@founderos/db";
import { assertCompanyAccess } from "./authz.js";
import { syncPostHog } from "../services/posthog-sync.js";
import {
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";

export function integrationDataRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/integration-data?kind=posthog.funnel
   * Returns the latest cached payload for the given (company, kind) pair.
   */
  router.get("/companies/:companyId/integration-data", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const kind = req.query.kind as string | undefined;
    if (!kind) {
      res.status(400).json({ error: "Query parameter 'kind' is required" });
      return;
    }

    const [row] = await db
      .select()
      .from(integrationData)
      .where(
        and(
          eq(integrationData.companyId, companyId),
          eq(integrationData.kind, kind),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "No integration data found for this kind" });
      return;
    }

    res.json({ payload: row.payload, fetchedAt: row.fetchedAt, kind: row.kind });
  });

  /**
   * POST /api/companies/:companyId/integrations/:id/sync
   * Triggers a synchronous re-sync for a PostHog integration.
   */
  router.post("/companies/:companyId/integrations/:id/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    // Look up the integration + decrypt the API key
    const [row] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, id),
          eq(integrations.companyId, companyId),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    if (row.kind !== "posthog") {
      res.status(400).json({ error: "Sync only supported for PostHog integrations" });
      return;
    }

    if (!row.encryptedApiKey) {
      res.status(400).json({ error: "Integration has no stored API key" });
      return;
    }

    let decryptedApiKey: string;
    try {
      decryptedApiKey = decryptWithMasterKey(row.encryptedApiKey);
    } catch {
      res.status(500).json({ error: "Failed to decrypt integration API key" });
      return;
    }

    const host =
      typeof (row.config as Record<string, unknown> | null)?.host === "string"
        ? ((row.config as Record<string, unknown>).host as string)
        : undefined;

    const result = await syncPostHog({
      db,
      integrationId: id,
      companyId,
      decryptedApiKey,
      host,
    });

    if (result.ok) {
      res.json(result);
    } else {
      res.status(502).json(result);
    }
  });

  return router;
}
