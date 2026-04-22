import { Router } from "express";
import type { Db } from "@founderos/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";
import {
  computeCoachingRecommendations,
  applyPermissionUpgrade,
} from "../services/permission-coach.js";
import { logActivity } from "../services/index.js";

const applyCoachingSchema = z.object({
  agentId: z.string().uuid(),
  targetLevel: z.enum(["observe", "suggest", "approve", "autonomous"]),
});

export function permissionCoachRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/companies/:companyId/permission-coach
   * Get permission upgrade/downgrade recommendations for all agents.
   */
  router.get("/companies/:companyId/permission-coach", async (req, res) => {
    const companyId = req.params.companyId as string;

    try {
      assertCompanyAccess(req, companyId);
    } catch (err) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const recommendations = await computeCoachingRecommendations(
        db,
        companyId,
      );
      res.json({ recommendations });
    } catch (err) {
      res.status(500).json({ error: "Failed to compute recommendations" });
    }
  });

  /**
   * POST /api/companies/:companyId/permission-coach/apply
   * Apply a recommended permission level change.
   * Body: { agentId, targetLevel }
   */
  router.post(
    "/companies/:companyId/permission-coach/apply",
    validate(applyCoachingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { agentId, targetLevel } = req.body;

      try {
        assertCompanyAccess(req, companyId);
      } catch (err) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      // Check for admin or company-level permissions
      const isAdmin = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
      if (!isAdmin) {
        res.status(403).json({ error: "Only admins can modify permissions" });
        return;
      }

      try {
        await applyPermissionUpgrade(db, agentId, companyId, targetLevel);

        // Log the activity
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          entityType: "agent",
          entityId: agentId,
          action: "agent.permission_level_changed",
        });

        res.json({ success: true });
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof Error ? err.message : "Failed to apply change" });
      }
    },
  );

  return router;
}
