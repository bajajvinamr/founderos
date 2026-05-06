import { Router } from "express";
import type { Db } from "@founderos/db";
import {
  createNotificationSchema,
  listNotificationsQuerySchema,
} from "@founderos/shared";
import { notificationsService } from "../services/notifications.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";

/**
 * Notifications (S6.6).
 *
 * Per-user, per-company notification surface. The UI bell, WS push, and
 * BullMQ Slack daily summary cron are wired in follow-ups; this route
 * exposes the data layer.
 *
 * RBAC:
 *   - GET endpoints — assertCompanyAccess (admin debug-view OK).
 *   - PATCH (mark-read) — must be the recipient. We never let a caller
 *     mark another user's notification read; the service is user-scoped.
 *   - POST (create) — board only; intended for internal callers (server-
 *     side jobs) but exposed here for the v1 UX (insight critical
 *     manual-flag). Cross-tenant create is blocked because the actor
 *     must have access to companyId.
 *
 * Routes:
 *   GET    /api/companies/:companyId/notifications           list (with ?unread=true|false&limit=N)
 *   GET    /api/companies/:companyId/notifications/unread-count
 *   POST   /api/companies/:companyId/notifications           create (server-internal use)
 *   POST   /api/companies/:companyId/notifications/:id/read  mark single read
 *   POST   /api/companies/:companyId/notifications/read-all  mark every unread read
 */
export function notificationRoutes(db: Db) {
  const router = Router();
  const service = notificationsService(db);

  function requireUserId(req: Parameters<Parameters<typeof router.get>[1]>[0]): string {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("User identity required for notifications");
    }
    return req.actor.userId;
  }

  router.get("/companies/:companyId/notifications", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireUserId(req);

    const parsed = listNotificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("invalid query parameters");

    const rows = await service.list(companyId, userId, {
      unread: parsed.data.unread,
      limit: parsed.data.limit,
    });
    res.json({ notifications: rows });
  });

  router.get(
    "/companies/:companyId/notifications/unread-count",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireUserId(req);

      const n = await service.unreadCount(companyId, userId);
      res.json({ unreadCount: n });
    },
  );

  router.post("/companies/:companyId/notifications", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = createNotificationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("invalid notification payload");

    const row = await service.create({
      companyId,
      userId: parsed.data.userId,
      kind: parsed.data.kind,
      title: parsed.data.title,
      body: parsed.data.body ?? null,
      refKind: parsed.data.refKind ?? null,
      refId: parsed.data.refId ?? null,
    });
    res.status(201).json(row);
  });

  router.post(
    "/companies/:companyId/notifications/:id/read",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireUserId(req);
      const notificationId = req.params.id as string;

      const ok = await service.markRead(notificationId, companyId, userId);
      if (!ok) {
        res.status(404).json({ error: "notification_not_found" });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.post(
    "/companies/:companyId/notifications/read-all",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = requireUserId(req);

      const updatedCount = await service.markAllRead(companyId, userId);
      res.json({ updatedCount });
    },
  );

  return router;
}
