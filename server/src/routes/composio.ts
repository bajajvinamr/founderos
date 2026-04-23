/**
 * Composio integration REST routes (Wave 21).
 *
 * Endpoints (all mounted under `/api`):
 *   GET  /composio/status
 *     Public-ish health check — returns `{ enabled, configuredApps }`. No
 *     API key or tenant data is ever included.
 *
 *   POST /companies/:companyId/composio/connect
 *     Body `{ appName }`. Starts Composio's managed OAuth for the current
 *     board user + (company, app). Inserts a pending `composio_connections`
 *     row and returns `{ redirectUrl, connectionId }`.
 *
 *   GET  /companies/:companyId/composio/connections
 *     Lists the `composio_connections` rows for this company, scoped to the
 *     board user making the call (other users' rows are NOT leaked).
 *
 * Tenant-isolation: every company-scoped route calls `requireCompanyAccess`
 * before touching the DB.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { requireCompanyAccess } from "../middleware/require-company-access.js";
import { assertBoard } from "./authz.js";
import { badRequest, unprocessable } from "../errors.js";
import {
  COMPOSIO_CONFIGURED_APPS,
  getComposioClient,
  isComposioEnabled,
} from "../services/composio-client.js";
import { logger } from "../middleware/logger.js";

const connectSchema = z.object({
  appName: z.string().min(1).max(64),
});

/**
 * Extract the current board user id from the request actor. The
 * `composio_connections.user_id` column is free-form text so we accept any
 * stable id the actor carries (`userId` for board actors).
 */
function getActorUserId(req: Parameters<Parameters<Router["get"]>[1]>[0]): string {
  const actor = req.actor;
  if (actor.type === "board" && typeof actor.userId === "string" && actor.userId) {
    return actor.userId;
  }
  // local_implicit dev mode — still allow so single-operator dev works.
  if (actor.source === "local_implicit") {
    return "local-implicit-user";
  }
  throw badRequest("Composio connect requires a board user session");
}

export function composioRoutes(db: Db) {
  const router = Router();

  /** GET /api/composio/status — enabled flag + list of apps we ship skills for. */
  router.get("/composio/status", (_req, res) => {
    res.json({
      enabled: isComposioEnabled(),
      configuredApps: [...COMPOSIO_CONFIGURED_APPS],
    });
  });

  /** POST /api/companies/:companyId/composio/connect */
  router.post(
    "/companies/:companyId/composio/connect",
    validate(connectSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      requireCompanyAccess(req, companyId);

      if (!isComposioEnabled()) {
        throw unprocessable("Composio is not enabled on this instance");
      }
      const client = getComposioClient();
      if (!client) {
        throw unprocessable("Composio client is not configured");
      }

      const { appName } = req.body as z.infer<typeof connectSchema>;
      const userId = getActorUserId(req);

      let initiation: { connectionId: string; redirectUrl: string };
      try {
        initiation = await client.initiateConnection({ userId, appName });
      } catch (err) {
        logger.error(
          { err, companyId, userId, appName },
          "composio: initiateConnection failed",
        );
        throw unprocessable(
          err instanceof Error ? err.message : "Failed to start Composio OAuth",
        );
      }

      // Upsert — same (company, user, app) overwrites the pending id.
      await db
        .insert(composioConnections)
        .values({
          companyId,
          userId,
          appName,
          composioConnectionId: initiation.connectionId,
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [
            composioConnections.companyId,
            composioConnections.userId,
            composioConnections.appName,
          ],
          set: {
            composioConnectionId: initiation.connectionId,
            status: "pending",
            updatedAt: new Date(),
          },
        });

      res.status(201).json({
        redirectUrl: initiation.redirectUrl,
        connectionId: initiation.connectionId,
      });
    },
  );

  /** GET /api/companies/:companyId/composio/connections */
  router.get("/companies/:companyId/composio/connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    requireCompanyAccess(req, companyId);
    const userId = getActorUserId(req);

    // Tenant isolation: even within the same company, users only see their
    // own connections. Instance admins get the full list for the company.
    const showAll =
      req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;

    const rows = showAll
      ? await db
          .select()
          .from(composioConnections)
          .where(eq(composioConnections.companyId, companyId))
      : await db
          .select()
          .from(composioConnections)
          .where(
            and(
              eq(composioConnections.companyId, companyId),
              eq(composioConnections.userId, userId),
            ),
          );

    // If a refresh query param is set, poll Composio for the latest status on
    // any pending rows so the UI can show up-to-date state without a webhook.
    if (req.query.refresh === "1" && isComposioEnabled()) {
      const client = getComposioClient();
      if (client) {
        for (const row of rows) {
          if (row.status !== "pending") continue;
          try {
            const live = await client.getConnection({
              connectionId: row.composioConnectionId,
            });
            if (live.status !== row.status) {
              await db
                .update(composioConnections)
                .set({ status: live.status, updatedAt: new Date() })
                .where(eq(composioConnections.id, row.id));
              row.status = live.status;
            }
          } catch (err) {
            logger.warn(
              { err, connectionId: row.composioConnectionId },
              "composio: refresh getConnection failed",
            );
          }
        }
      }
    }

    res.json({
      connections: rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        userId: r.userId,
        appName: r.appName,
        connectionId: r.composioConnectionId,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  return router;
}
