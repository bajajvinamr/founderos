/**
 * PostHog connector routes (S2.3)
 *
 * POST /api/integrations/posthog/connect
 *   Validates the API key live, then stores it encrypted in the `integrations`
 *   table (kind='posthog'). The projectId and host are stored in config.
 *
 * POST /api/integrations/posthog/webhook
 *   HMAC-SHA256 signature-verified webhook receiver. Maps PostHog event types
 *   to the canonical ingestEvent() shape (source='posthog').
 *
 * Auth model: PostHog uses API key auth, NOT OAuth/Composio. Connection state
 * lives in the `integrations` table (reusing existing schema).
 *
 * Schema decision: reuse `integrations` table (kind='posthog', encrypted API
 * key, config JSONB for projectId + host). No new migration needed.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import {
  createPostHogClient,
  verifyPostHogWebhookSignature,
  PostHogAuthError,
} from "../services/posthog-client.js";
import { integrationService } from "../services/integrations.js";
import { ingestEvent } from "../services/event-ingest-stub.js";
import { logger } from "../middleware/logger.js";

// ─── Validation schemas ────────────────────────────────────────────────────────

const connectBodySchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.union([z.string().min(1), z.number().int().positive()]),
  apiKey: z.string().min(1, "apiKey is required"),
  host: z
    .enum(["https://app.posthog.com", "https://eu.posthog.com", "https://us.posthog.com"])
    .optional()
    .default("https://app.posthog.com"),
});

type ConnectBody = z.infer<typeof connectBodySchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveEntityType(eventName: string): string {
  if (eventName === "$pageview") return "pageview";
  if (eventName === "$identify") return "identify";
  if (eventName === "$autocapture") return "capture";
  return "event";
}

function parseTimestamp(value: unknown): Date {
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function postHogRoutes(db: Db) {
  const router = Router();
  const integrations = integrationService(db);

  /**
   * POST /api/integrations/posthog/connect
   *
   * Body: { companyId, projectId, apiKey, host? }
   *
   * 1. Validates the key live against the PostHog REST API.
   * 2. Stores the encrypted key in `integrations` with kind='posthog'.
   *    The projectId + host are stored in the config JSONB column.
   * 3. Returns the integration row (no secrets).
   */
  router.post(
    "/integrations/posthog/connect",
    validate(connectBodySchema),
    async (req: Request, res: Response): Promise<void> => {
      const { companyId, projectId, apiKey, host } = req.body as ConnectBody;

      assertCompanyAccess(req, companyId);

      const client = createPostHogClient({ apiKey, host });
      let projectName: string;
      try {
        const project = await client.validateApiKey(projectId);
        projectName = project.name;
      } catch (err: unknown) {
        if (err instanceof PostHogAuthError) {
          res.status(400).json({ error: "Invalid PostHog API key" });
          return;
        }
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          { err, companyId },
          `posthog-connect: validateApiKey failed — ${msg}`,
        );
        res.status(502).json({ error: `PostHog validation failed: ${msg}` });
        return;
      }

      const integration = await integrations.create(companyId, {
        kind: "posthog",
        apiKey: apiKey.trim(),
        config: {
          projectId: String(projectId),
          projectName,
          host,
        },
      });

      logger.info(
        { companyId, integrationId: integration.id, projectId },
        "posthog-connect: connection stored",
      );

      res.status(201).json(integration);
    },
  );

  /**
   * POST /api/integrations/posthog/webhook
   *
   * HMAC-SHA256 verified webhook receiver for PostHog events.
   * Required query param: companyId
   * Required header: PostHog-Signature (sha256=<hex>)
   *
   * The raw body is preserved by app.ts express.json verify callback.
   */
  router.post(
    "/integrations/posthog/webhook",
    async (req: Request, res: Response): Promise<void> => {
      const companyId = req.query["companyId"];
      if (typeof companyId !== "string" || !companyId) {
        res.status(400).json({ error: "Missing companyId query parameter" });
        return;
      }

      const integration = await integrations.getByKind(companyId, "posthog");
      if (!integration) {
        res.status(200).json({ ok: false, reason: "integration not found" });
        return;
      }

      const signature = req.headers["posthog-signature"] as string | undefined;
      const rawBody: Buffer | undefined = (
        req as unknown as { rawBody?: Buffer }
      ).rawBody;

      if (!signature || !rawBody) {
        res.status(401).json({ error: "Missing signature or raw body" });
        return;
      }

      const webhookSecret =
        typeof integration.config?.webhookSecret === "string"
          ? integration.config.webhookSecret
          : null;

      if (!webhookSecret) {
        logger.warn(
          { companyId, integrationId: integration.id },
          "posthog-webhook: no webhook secret configured — rejecting",
        );
        res.status(401).json({ error: "Webhook secret not configured" });
        return;
      }

      const valid = verifyPostHogWebhookSignature(rawBody, signature, webhookSecret);
      if (!valid) {
        res.status(401).json({ error: "Invalid HMAC signature" });
        return;
      }

      let payload: unknown;
      try {
        payload = typeof req.body === "object" ? req.body : JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }

      const events = Array.isArray(payload) ? payload : [payload];
      let ingested = 0;

      for (const raw of events) {
        if (!raw || typeof raw !== "object") continue;

        const ev = raw as Record<string, unknown>;
        const eventName = typeof ev["event"] === "string" ? ev["event"] : "unknown";
        const eventId = typeof ev["id"] === "string" ? ev["id"] : undefined;
        const timestamp = parseTimestamp(ev["timestamp"]);
        const distinctId = typeof ev["distinct_id"] === "string" ? ev["distinct_id"] : undefined;
        const entityType = resolveEntityType(eventName);

        try {
          await ingestEvent({
            companyId,
            source: "posthog",
            entityType,
            eventName,
            sourceEventId: eventId,
            occurredAt: timestamp,
            payload: {
              distinctId,
              properties: (ev["properties"] as Record<string, unknown>) ?? {},
              raw: ev,
            },
          });
          ingested++;
        } catch (err: unknown) {
          logger.error(
            { err, companyId, eventName, eventId },
            "posthog-webhook: ingestEvent failed",
          );
        }
      }

      res.status(200).json({ ok: true, ingested });
    },
  );

  return router;
}
