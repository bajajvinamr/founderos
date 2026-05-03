/**
 * Debug endpoints — admin-only. Useful as canaries for monitoring
 * (Sentry, uptime alerts). Never exposed to non-admin traffic.
 */

import { Router } from "express";
import { assertBoard } from "./authz.js";

export function debugRoutes() {
  const router = Router();

  /**
   * GET /api/debug/sentry-canary
   * Throws an intentional error so you can verify Sentry is capturing
   * server-side exceptions end-to-end. Gated to instance admins so
   * random traffic can't spam Sentry. The thrown error includes the
   * requestId so you can grep both server logs AND the Sentry event by
   * the same ID — the canonical "wire ≠ working" verification.
   */
  router.get("/debug/sentry-canary", (req, _res) => {
    assertBoard(req);
    if (!req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
      const err = new Error("Forbidden: instance admin required for debug endpoints");
      (err as { status?: number }).status = 403;
      throw err;
    }
    const reqId = (req as { requestId?: string }).requestId ?? "unknown";
    throw new Error(
      `Sentry canary [requestId=${reqId}] — intentional error thrown at ${new Date().toISOString()}. ` +
        `If you see this event in Sentry tagged with the same requestId, the capture pipeline + ` +
        `request-context enrichment are working end-to-end.`,
    );
  });

  /**
   * GET /api/debug/echo
   * Returns info about the current actor + request — handy for verifying
   * auth is hooked up correctly. Admin-gated.
   */
  router.get("/debug/echo", (req, res) => {
    assertBoard(req);
    if (!req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
      res.status(403).json({ error: "Instance admin required" });
      return;
    }
    res.json({
      actor: req.actor,
      env: {
        composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
        sentryEnabled: Boolean(process.env.SENTRY_DSN),
        deploymentMode: process.env.FOUNDEROS_DEPLOYMENT_MODE ?? null,
        nodeVersion: process.versions.node,
      },
      now: new Date().toISOString(),
    });
  });

  return router;
}
