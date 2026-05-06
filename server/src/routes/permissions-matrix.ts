import { Router } from "express";
import type { Db } from "@founderos/db";
import { computePermissionsMatrix } from "../services/permissions-matrix.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Permissions matrix (S6.1).
 *
 * GET /api/companies/:companyId/permissions-matrix → PermissionsMatrix
 *
 * Read-only aggregator over workspace_departments, workflows, and
 * instance_settings. Mutation flows back through the existing endpoints:
 *   - Dept autonomy → PATCH /api/companies/:id/departments/:deptId
 *   - Workflow autonomy → PATCH /api/companies/:id/workflows/:wfId
 *   - Instance master switch → PATCH /api/instance/settings/general
 *
 * Why no separate PATCH on this route: the existing endpoints already
 * have audit logging + autonomy gates (`guardAutonomousUpgrade`,
 * `assertStrictCompanyMembership`) wired in. Duplicating those in a
 * matrix-specific PATCH would create a second authorization path to
 * keep in sync — drift is a real risk for security-sensitive code.
 *
 * RBAC: read = assertCompanyAccess (instance admins can debug-view).
 * Writes use the upstream endpoints which apply strict membership.
 */
export function permissionsMatrixRoutes(db: Db) {
  const router = Router();

  router.get(
    "/companies/:companyId/permissions-matrix",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const matrix = await computePermissionsMatrix(db, companyId);
      res.json(matrix);
    },
  );

  return router;
}
