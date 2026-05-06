import { Router } from "express";
import type { Db } from "@founderos/db";
import { expandAuditLineage } from "../services/audit-lineage.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Audit lineage (S6.3).
 *
 * GET /api/audit/:logId/lineage → LineageExpansion
 *
 * Expands the lineage_refs jsonb column on a single activity_log row.
 * Returns 404 when the log row doesn't exist; otherwise returns the
 * full expansion (with empty arrays for missing references).
 *
 * RBAC: assertCompanyAccess on the resolved row's companyId. The
 * lineage service is itself tenant-scoped on every reference query
 * (defense in depth) so an attacker who somehow obtained a foreign
 * logId still couldn't pivot through into another tenant's insights/
 * approvals/events.
 */
export function auditLineageRoutes(db: Db) {
  const router = Router();

  router.get("/audit/:logId/lineage", async (req, res) => {
    const logId = req.params.logId as string;

    const expansion = await expandAuditLineage(db, logId);
    if (!expansion) {
      res.status(404).json({ error: "audit_log_not_found" });
      return;
    }

    assertCompanyAccess(req, expansion.log.companyId);
    res.json(expansion);
  });

  return router;
}
