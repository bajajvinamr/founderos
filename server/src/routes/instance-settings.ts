import { Router, type Request } from "express";
import type { Db } from "@founderos/db";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema } from "@founderos/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { reinitTelemetryFromInstanceSettings } from "../telemetry.js";
import { logger } from "../middleware/logger.js";
import { getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);

  router.get("/instance/settings/general", async (req, res) => {
    // General settings (e.g. keyboardShortcuts) are readable by any
    // authenticated board user.  Only PATCH requires instance-admin.
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);

      // Council 2026-05-05 P2 (C1) — if the patch touched telemetryConsent,
      // re-initialize the runtime telemetry client so the toggle takes effect
      // without a server restart. Non-fatal: a hydration failure logs but
      // doesn't block the PATCH response (the persisted state remains correct
      // and will hydrate on next boot).
      if (Object.prototype.hasOwnProperty.call(req.body, "telemetryConsent")) {
        try {
          await reinitTelemetryFromInstanceSettings(db);
        } catch (err) {
          logger.warn({ err }, "telemetry: hot reinit after settings patch failed");
        }
      }

      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  router.get("/instance/settings/experimental", async (req, res) => {
    // Experimental settings are readable by any authenticated board user.
    // Only PATCH requires instance-admin.
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  return router;
}
