import { Router } from "express";
import type { Db } from "@founderos/db";
import { createIntegrationSchema } from "@founderos/shared";
import { validate } from "../middleware/validate.js";
import {
  integrationService,
  logActivity,
  deliverMorningBriefToSlack,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function integrationRoutes(db: Db) {
  const router = Router();
  const integrations = integrationService(db);

  /**
   * GET /api/companies/:companyId/integrations
   * List all integrations for a company. No secrets returned.
   */
  router.get("/companies/:companyId/integrations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const list = await integrations.list(companyId);
    res.json(list);
  });

  /**
   * POST /api/companies/:companyId/integrations
   * Create or reconnect an integration. Encrypts the API key.
   */
  router.post(
    "/companies/:companyId/integrations",
    validate(createIntegrationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const integration = await integrations.create(companyId, {
        kind: req.body.kind,
        apiKey: req.body.apiKey,
        config: req.body.config,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "integration.connected",
        entityType: "integration",
        entityId: integration.id,
        details: { kind: integration.kind },
      });

      res.status(201).json(integration);
    },
  );

  /**
   * DELETE /api/companies/:companyId/integrations/:id
   * Remove an integration.
   */
  router.delete("/companies/:companyId/integrations/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    // Fetch the integration before deleting so we can log the kind
    const list = await integrations.list(companyId);
    const existing = list.find((i) => i.id === id);

    const removed = await integrations.remove(companyId, id);
    if (!removed) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "integration.disconnected",
      entityType: "integration",
      entityId: id,
      details: existing ? { kind: existing.kind } : {},
    });

    res.status(204).end();
  });

  /**
   * POST /api/companies/:companyId/integrations/:id/test
   * Stub health-check endpoint. Future wave replaces with real check.
   */
  router.post("/companies/:companyId/integrations/:id/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ ok: true, lastChecked: new Date().toISOString() });
  });

  /**
   * POST /api/companies/:companyId/integrations/:id/slack/deliver-brief
   * Manually trigger Morning Brief delivery to Slack (test endpoint).
   */
  router.post(
    "/companies/:companyId/integrations/:id/slack/deliver-brief",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const integrationId = req.params.id as string;
      assertCompanyAccess(req, companyId);

      // Fetch integration and decrypt bot token
      const integration = await integrations.getByKind(companyId, "slack");
      if (!integration || integration.id !== integrationId) {
        res.status(404).json({ error: "Slack integration not found" });
        return;
      }

      const botToken = await integrations.getDecryptedApiKey(companyId, integrationId);
      if (!botToken) {
        res.status(400).json({ error: "Failed to decrypt Slack bot token" });
        return;
      }

      const result = await deliverMorningBriefToSlack({
        db,
        companyId,
        integrationId,
        decryptedBotToken: botToken,
      });

      if (result.ok) {
        res.json({
          ok: true,
          channel: result.channel,
          ts: result.ts,
          message: "Morning brief delivered successfully",
        });
      } else {
        res.status(400).json({
          ok: false,
          error: result.error,
        });
      }
    },
  );

  return router;
}
