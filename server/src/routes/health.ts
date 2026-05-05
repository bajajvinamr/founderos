import { Router } from "express";
import type { Db } from "@founderos/db";
import { and, count, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  instanceUserRoles,
  invites,
  companies,
  runnerJobs,
  runnerTokens,
} from "@founderos/db";
import type { DeploymentExposure, DeploymentMode } from "@founderos/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { LOCAL_BOARD_USER_ID } from "../auth/post-signup-hook.js";
import { isByoRunnerEnabled } from "../lib/byo-runner-flag.js";
import { serverVersion } from "../version.js";
import { assertInstanceAdmin } from "./authz.js";

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

  router.get("/", async (req, res) => {
    // Council 2026-05-05 P3 — minimize reconnaissance surface for unauth
    // callers. `deploymentExposure`, `features.*`, and `devServer` are not
    // consumed by the UI in unauth paths (verified by grep against ui/src);
    // strip them when the caller hasn't presented credentials. The remaining
    // fields (`deploymentMode`, `authReady`, `bootstrapStatus`,
    // `bootstrapInviteActive`) are UI-load-bearing for the unauth onboarding
    // flow — App.tsx + InviteLanding read these BEFORE the user is signed in
    // to decide signup-vs-login. The full strip to {ok, version} (per the
    // council's literal recommendation) requires splitting bootstrap state
    // to its own endpoint + updating UI consumers — tracked separately for
    // Sprint 4. actorMiddleware always runs before this route, so `req.actor`
    // is reliably populated; `type === "none"` means unauthenticated.
    const isAuthed = req.actor?.type != null && req.actor.type !== "none";

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
      // Mirror runPostSignupBootstrap's first-user-wins rule: the synthetic
      // local-board principal does NOT count as a human admin. Counting it
      // here previously caused health to report "ready" while every signed-in
      // user still got "Instance admin required" on first onboarding POST.
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.role, "instance_admin"),
            ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
          ),
        )
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

    const baseResponse = {
      status: "ok" as const,
      version: serverVersion,
      // UI-load-bearing for unauth onboarding flow (App.tsx + InviteLanding):
      deploymentMode: opts.deploymentMode,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
    };

    if (isAuthed) {
      res.json({
        ...baseResponse,
        deploymentExposure: opts.deploymentExposure,
        features: {
          companyDeletionEnabled: opts.companyDeletionEnabled,
        },
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json(baseResponse);
  });

  // Deep health check: exercises the full stack.
  //
  // Council 2026-05-04: this endpoint exposes DB latency, table-level reachability,
  // session-resolver internals, Composio platform liveness, runner queue depth,
  // Sentry config — all useful for ops, all reconnaissance gold for an attacker
  // probing an exposed instance. Gate behind instance_admin in authenticated mode.
  // local_trusted (dev) keeps the open path via assertInstanceAdmin's
  // local_implicit short-circuit. Fly liveness/readiness probes hit
  // /api/healthz and /api/readyz (per fly.toml [[services.http_checks]]),
  // not /deep — gating does not break the deploy infra.
  router.get("/deep", async (req, res) => {
    assertInstanceAdmin(req);
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
      const actor = req.actor;
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

    // 5. Runner metrics — BYO-110. Aggregate counts only (no per-token detail)
    //    so the unauthenticated surface doesn't leak per-tenant info beyond
    //    what /deep already exposes. Skipped entirely when the BYO runner
    //    flag is off.
    if (isByoRunnerEnabled()) {
      const runnerStart = Date.now();
      try {
        if (!db) {
          checks.push({
            name: "runner_metrics",
            status: "skipped",
            latencyMs: 0,
            detail: "no db instance",
          });
        } else {
          // Single round-trip: aggregate-by-status for jobs + active/online
          // counts for tokens. The status sub-counts use SQL filter clauses
          // so we only hit the table once each.
          const [jobAgg] = (await Promise.race([
            db.execute(sql<{
              queued: number;
              claimed: number;
              streaming: number;
            }>`
              SELECT
                COALESCE(SUM(CASE WHEN ${runnerJobs.status} = 'queued'    THEN 1 ELSE 0 END), 0)::int AS queued,
                COALESCE(SUM(CASE WHEN ${runnerJobs.status} = 'claimed'   THEN 1 ELSE 0 END), 0)::int AS claimed,
                COALESCE(SUM(CASE WHEN ${runnerJobs.status} = 'streaming' THEN 1 ELSE 0 END), 0)::int AS streaming
              FROM ${runnerJobs}
            `),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("runner metrics timeout")), 500),
            ),
          ])) as unknown as Array<{ queued: number; claimed: number; streaming: number }>;

          // Online window matches the auth middleware's lastSeenAt debounce
          // (30 s). Tokens lookup is independent — a runner with no jobs to
          // process still polls /jobs/next and counts as online. Pass the
          // ISO string explicitly: drizzle's `sql` template doesn't coerce
          // Date through the embedded-postgres (pglite) driver, even though
          // the production driver does — keeps the same code path green in
          // both test and prod.
          const onlineSinceIso = new Date(Date.now() - 30_000).toISOString();
          const [tokenAgg] = (await db.execute(sql<{
            active: number;
            online: number;
          }>`
            SELECT
              COALESCE(SUM(CASE WHEN ${runnerTokens.revokedAt} IS NULL THEN 1 ELSE 0 END), 0)::int AS active,
              COALESCE(SUM(CASE WHEN ${runnerTokens.revokedAt} IS NULL
                                  AND ${runnerTokens.lastSeenAt} >= ${onlineSinceIso}::timestamptz
                                THEN 1 ELSE 0 END), 0)::int AS online
            FROM ${runnerTokens}
          `)) as unknown as Array<{ active: number; online: number }>;

          checks.push({
            name: "runner_metrics",
            status: "ok",
            latencyMs: Date.now() - runnerStart,
            detail: `jobs:queued=${jobAgg.queued},claimed=${jobAgg.claimed},streaming=${jobAgg.streaming}; tokens:active=${tokenAgg.active},online=${tokenAgg.online}`,
          });
        }
      } catch (error) {
        checks.push({
          name: "runner_metrics",
          status: "fail",
          latencyMs: Date.now() - runnerStart,
          detail: error instanceof Error ? error.message : "unknown error",
        });
        // Don't downgrade overall — runner metrics are observability, not
        // a load-bearing capability. Failing tells ops to look but doesn't
        // imply the API is degraded for end users.
      }
    } else {
      checks.push({
        name: "runner_metrics",
        status: "skipped",
        latencyMs: 0,
        detail: "FOUNDEROS_BYO_RUNNER_ENABLED not set",
      });
    }

    // 6. Sentry wired: check DSN is non-empty
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
