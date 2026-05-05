import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { departments, workspaceDepartments } from "@founderos/db";
import { and, eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";

const patchDepartmentSchema = z.object({
  enabled: z.boolean().optional(),
  autonomyLevel: z.number().int().min(1).max(4).optional(),
});

export function departmentRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/departments
   * Returns workspace_departments rows joined with departments catalogue.
   * Only lists departments that have a workspace_departments row (i.e. those
   * backfilled or explicitly toggled). Falls back gracefully for companies
   * that haven't been backfilled yet by also returning the core catalogue.
   */
  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select({
        id: workspaceDepartments.id,
        companyId: workspaceDepartments.companyId,
        departmentId: workspaceDepartments.departmentId,
        enabled: workspaceDepartments.enabled,
        autonomyLevel: workspaceDepartments.autonomyLevel,
        createdAt: workspaceDepartments.createdAt,
        label: departments.label,
        description: departments.description,
        icon: departments.icon,
        sortOrder: departments.sortOrder,
        isCore: departments.isCore,
      })
      .from(workspaceDepartments)
      .innerJoin(departments, eq(workspaceDepartments.departmentId, departments.id))
      .where(eq(workspaceDepartments.companyId, companyId))
      .orderBy(departments.sortOrder);

    res.json(rows);
  });

  /**
   * PATCH /api/companies/:companyId/departments/:departmentId
   * Toggle enabled/disabled or change autonomy level for a department.
   * Creates the workspace_departments row if it doesn't exist yet.
   */
  router.patch(
    "/companies/:companyId/departments/:departmentId",
    validate(patchDepartmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const departmentId = req.params.departmentId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof patchDepartmentSchema>;

      // Verify the department exists in the catalogue
      const [dept] = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, departmentId))
        .limit(1);

      if (!dept) {
        throw notFound(`Department '${departmentId}' not found`);
      }

      // Upsert the workspace_departments row
      const updateValues: Record<string, unknown> = {};
      if (body.enabled !== undefined) updateValues.enabled = body.enabled;
      if (body.autonomyLevel !== undefined) updateValues.autonomyLevel = body.autonomyLevel;

      await db
        .insert(workspaceDepartments)
        .values({
          companyId,
          departmentId,
          enabled: body.enabled ?? true,
          autonomyLevel: body.autonomyLevel ?? 2,
        })
        .onConflictDoUpdate({
          target: [workspaceDepartments.companyId, workspaceDepartments.departmentId],
          set: updateValues,
        });

      const [updated] = await db
        .select({
          id: workspaceDepartments.id,
          companyId: workspaceDepartments.companyId,
          departmentId: workspaceDepartments.departmentId,
          enabled: workspaceDepartments.enabled,
          autonomyLevel: workspaceDepartments.autonomyLevel,
          createdAt: workspaceDepartments.createdAt,
          label: departments.label,
          description: departments.description,
          icon: departments.icon,
          sortOrder: departments.sortOrder,
          isCore: departments.isCore,
        })
        .from(workspaceDepartments)
        .innerJoin(departments, eq(workspaceDepartments.departmentId, departments.id))
        .where(
          and(
            eq(workspaceDepartments.companyId, companyId),
            eq(workspaceDepartments.departmentId, departmentId),
          ),
        )
        .limit(1);

      res.json(updated);
    },
  );

  return router;
}
