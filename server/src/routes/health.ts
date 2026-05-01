import { Router } from "express";
import type { Db } from "@founderos/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites, companies } from "@founderos/db";
import type { DeploymentExposure, DeploymentMode } from "@founderos/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok", version: serverVersion });
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable",
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus) {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  // Deep health check: exercises the full stack
  router.get("/deep", async (req, res) => {
    const checks: Array<{
      name: string;
      status: "ok" | "fail" | "skipped";
      latencyMs: number;
      detail?: string;
    }> = [];
    let overallStatus: "ok" | "degraded" | "failing" = "ok";

    // 1. DB round-trip: SELECT 1
    const dbStart = Date.now();
    try {
      if (!db) {
        checks.push({
          name: "db_roundtrip",
          status: "skipped",
          latencyMs: 0,
          detail: "no db instance",
        });
      } else {
        await Promise.race([
          db.execute(sql`SELECT 1`),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("db timeout")), 200)
          ),
        ]);
        const latency = Date.now() - dbStart;
        checks.push({
          name: "db_roundtrip",
          status: "ok",
          latencyMs: latency,
        });
      }
    } catch (error) {
      const latency = Date.now() - dbStart;
      checks.push({
        name: "db_roundtrip",
        status: "fail",
        latencyMs: latency,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      overallStatus = "failing";
    }

    // 2. Table check: SELECT count(*) FROM companies
    const tableStart = Date.now();
    try {
      if (!db) {
        checks.push({
          name: "table_check",
          status: "skipped",
          latencyMs: 0,
          detail: "no db instance",
        });
      } else {
        await Promise.race([
          db.select({ count: count() }).from(companies).limit(1),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("table check timeout")), 200)
          ),
        ]);
        const latency = Date.now() - tableStart;
        checks.push({
          name: "table_check",
          status: "ok",
          latencyMs: latency,
        });
      }
    } catch (error) {
      const latency = Date.now() - tableStart;
      checks.push({
        name: "table_check",
        status: "fail",
        latencyMs: latency,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      overallStatus = "failing";
    }

    // 3. Session resolver: confirm req.actor.type is set
    const sessionStart = Date.now();
    try {
      const actor: Express.Request["actor"] | undefined = (req as unknown as { actor?: Express.Request["actor"] }).actor;
      if (!actor || !actor.type) {
        checks.push({
          name: "session_resolver",
          status: "fail",
          latencyMs: Date.now() - sessionStart,
          detail: "actor.type not set",
        });
        overallStatus = "degraded";
      } else {
        checks.push({
          name: "session_resolver",
          status: "ok",
          latencyMs: Date.now() - sessionStart,
          detail: actor.type,
        });
      }
    } catch (error) {
      checks.push({
        name: "session_resolver",
        status: "fail",
        latencyMs: Date.now() - sessionStart,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      overallStatus = "degraded";
    }

    // 4. Composio ping (optional if COMPOSIO_API_KEY set)
    if (process.env.COMPOSIO_API_KEY) {
      const composioStart = Date.now();
      try {
        const response = await Promise.race([
          // Any authenticated Composio endpoint works as a liveness check.
          // /internal/sdk/metadata used to be public but returns 410 now.
          // /api/v1/auth-configs is a stable authed endpoint that returns
          // the org's configured auth providers — perfect ping target.
          // Composio v1 API was fully deprecated (410). v3 is the current
          // surface. /toolkits is a lightweight authed read — 200 on valid
          // key, 401 otherwise. Base URL env var covers the v1 client path;
          // health check hardcodes v3 host so we verify the real platform.
          fetch("https://backend.composio.dev/api/v3/toolkits?limit=1", {
            method: "GET",
            headers: {
              "x-api-key": process.env.COMPOSIO_API_KEY ?? "",
              "User-Agent": "FounderOS/health-check",
            },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("composio timeout")), 3000)
          ),
        ]);
        const latency = Date.now() - composioStart;
        if (!response || !(response instanceof Response)) {
          throw new Error("invalid response");
        }
        if (response.ok) {
          checks.push({
            name: "composio_ping",
            status: "ok",
            latencyMs: latency,
          });
        } else {
          checks.push({
            name: "composio_ping",
            status: "fail",
            latencyMs: latency,
            detail: `HTTP ${response.status}`,
          });
          overallStatus = "degraded";
        }
      } catch (error) {
        const latency = Date.now() - composioStart;
        checks.push({
          name: "composio_ping",
          status: "fail",
          latencyMs: latency,
          detail: error instanceof Error ? error.message : "unknown error",
        });
        overallStatus = "degraded";
      }
    } else {
      checks.push({
        name: "composio_ping",
        status: "skipped",
        latencyMs: 0,
        detail: "COMPOSIO_API_KEY not set",
      });
    }

    // 5. Sentry wired: check DSN is non-empty
    const sentryStart = Date.now();
    if (process.env.SENTRY_DSN) {
      checks.push({
        name: "sentry_wired",
        status: "ok",
        latencyMs: Date.now() - sentryStart,
      });
    } else {
      checks.push({
        name: "sentry_wired",
        status: "fail",
        latencyMs: Date.now() - sentryStart,
        detail: "SENTRY_DSN not set",
      });
      overallStatus = "degraded";
    }

    const statusCode = overallStatus === "failing" ? 503 : 200;
    res.status(statusCode).json({
      status: overallStatus,
      checks,
      version: serverVersion,
    });
  });

  return router;
}
