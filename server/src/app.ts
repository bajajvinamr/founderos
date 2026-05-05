import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@founderos/db";
import type { DeploymentExposure, DeploymentMode } from "@founderos/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler, sentryErrorHandler, requestIdMiddleware } from "./middleware/index.js";
import { securityHeadersMiddleware } from "./middleware/security-headers.js";
import { updateRequestContext, runInCronContext } from "./lib/request-context.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { routineRoutes } from "./routes/routines.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { instanceInvitesRoutes } from "./routes/instance-invites.js";
import { templateRoutes } from "./routes/templates.js";
import { integrationRoutes } from "./routes/integrations.js";
import { integrationHealthRoutes } from "./routes/integration-health.js";
import { insightRoutes } from "./routes/insights.js";
import { postHogRoutes } from "./routes/posthog-connector.js";
import { oauthRoutes } from "./routes/oauth.js";
import { companyMemoryRoutes } from "./routes/company-memory.js";
import { conversationRoutes } from "./routes/conversations.js";
import { integrationDataRoutes } from "./routes/integration-data.js";
import { agentReviewRoutes } from "./routes/agent-reviews.js";
import { companyProviderRoutes } from "./routes/company-providers.js";
import { decisionOutcomeRoutes } from "./routes/decision-outcomes.js";
import { createDecisionFollowupCron } from "./services/decision-followup-cron.js";
import { createWeeklyWrapDeliveryCron } from "./services/weekly-wrap-delivery-cron.js";
import { weeklyWrapRoutes } from "./routes/weekly-wraps.js";
import { dailyBriefRoutes } from "./routes/daily-briefs.js";
import { createDailyFounderBriefCron } from "./jobs/daily-founder-brief.js";
import { billingRoutes } from "./routes/billing.js";
import { stripeBackfillRoutes } from "./routes/stripe-backfill.js";
import { agentHandoffRoutes } from "./routes/agent-handoffs.js";
import { composioRoutes } from "./routes/composio.js";
import { debugRoutes } from "./routes/debug.js";
import { hireProposalRoutes } from "./routes/hire-proposal.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { permissionCoachRoutes } from "./routes/permission-coach.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { byoKeyRoutes } from "./routes/byo-key.js";
import { digestRoutes } from "./routes/digest.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { runnerJobRoutes, runnerTokenManagementRoutes } from "./routes/runner.js";
import { runnerAuthMiddleware } from "./middleware/runner-auth.js";
import { departmentRoutes } from "./routes/departments.js";
import { departmentStatusRoutes } from "./routes/department-status.js";
import { experimentRoutes } from "./routes/experiments.js";
import { funnelRoutes } from "./routes/funnel.js";
import { isByoRunnerEnabled } from "./lib/byo-runner-flag.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { applyUiBranding } from "./ui-branding.js";
import { authWebhookRoutes } from "./routes/auth-webhook.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createDailyDigestCron } from "./services/daily-digest-cron.js";
import { createEmailSender } from "./services/email-sender.js";
import { createLinkedInSyncCron } from "./services/linkedin-sync-cron.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@founderos/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    /** Auth provider in use — surfaced to the UI via /api/auth/config. */
    authProvider?: "clerk" | "better-auth" | "local_trusted" | "supabase";
    /** Clerk publishable key — safe to send to the browser. */
    authPublishableKey?: string;
    /** Supabase anon (public) key — safe to send to the browser. */
    authSupabaseAnonKey?: string;
    /** Supabase project URL — safe to send to the browser. */
    authSupabaseUrl?: string;
    /**
     * Optional Supabase webhook shared secret. When set, mounts
     * `POST /api/auth/webhook` which receives Supabase Auth user.created
     * events and runs the post-signup bootstrap.
     */
    supabaseWebhookSecret?: string;
  },
) {
  const app = express();

  // Mount request-id BEFORE httpLogger so pino-http picks up `req.id`
  // from the AsyncLocalStorage context. Mount BEFORE express.json so
  // body-parse errors are logged with the correct correlation ID.
  app.use(requestIdMiddleware());
  // Security baseline (CSP + X-Frame + nosniff + Referrer + HSTS) applied
  // to every response branch — including 4xx/5xx error paths. Mount before
  // route handlers so per-route overrides (e.g. assets.ts sandbox CSP)
  // happen on top of, not under, the baseline.
  app.use(
    securityHeadersMiddleware({
      supabaseUrl: opts.authSupabaseUrl ?? null,
    }),
  );
  app.use(express.json({
    // Company import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  // Once actor is resolved, copy it into the AsyncLocalStorage request
  // context so log lines and Sentry events are auto-tagged with userId,
  // companyId, isInstanceAdmin, etc. — without every call site needing
  // to thread the actor through.
  app.use((req, _res, next) => {
    if (req.actor) {
      updateRequestContext({
        actor: {
          type: req.actor.type,
          userId: req.actor.userId,
          companyId: req.actor.companyId,
          isInstanceAdmin: req.actor.isInstanceAdmin,
          source: req.actor.source,
        },
        routePath: (req as { route?: { path?: string } }).route?.path,
      });
    }
    next();
  });
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `founderos:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  /**
   * Public-safe auth config — consumed by the UI on boot to decide whether
   * to render ClerkProvider + <SignIn /> or the legacy email/password form.
   * Never returns the secret key; only the publishable key (safe in client
   * JS) + the provider tag.
   */
  app.get("/api/auth/config", (_req, res) => {
    res.json({
      provider: opts.authProvider ?? "local_trusted",
      publishableKey: opts.authPublishableKey ?? null,
      supabaseUrl: opts.authSupabaseUrl ?? null,
      supabaseAnonKey: opts.authSupabaseAnonKey ?? null,
    });
  });
  // Supabase webhook route — must be mounted BEFORE the better-auth wildcard
  // so /api/auth/webhook reaches our handler instead of being swallowed.
  if (opts.authProvider === "supabase") {
    // Council 2026-05-03 P3 (Gemini) — mount unconditionally so the
    // designed 503 fail-closed in auth-webhook.ts:52 is reachable. The
    // previous gate-on-secret-presence dropped to the catch-all 404
    // when SUPABASE_WEBHOOK_SECRET was unset, hiding the configuration
    // error from operators. The route controller handles the missing-
    // secret case explicitly.
    app.use(authWebhookRoutes(db, { webhookSecret: opts.supabaseWebhookSecret }));
  }
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Runner-token surface — outside the session-auth `api` Router so it doesn't
  // pick up boardMutationGuard or session resolution. Behind its own bearer
  // auth middleware (BYO-101). Gated by FOUNDEROS_BYO_RUNNER_ENABLED so it
  // returns 404 (default not-found) until the flag flips on. ADR-011.
  if (isByoRunnerEnabled()) {
    app.use("/api/runner", runnerAuthMiddleware(db), runnerJobRoutes(db));
  }

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());

  /**
   * Liveness probe — cheap (no DB call) so Fly.io / k8s can hit it every
   * second without worrying about latency. Returns 200 if the process is
   * alive and the event loop responds.
   */
  api.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  /**
   * Readiness probe — stricter: verifies DB connectivity + auth bootstrap
   * state. Use this for deploy gating and scale-up decisions.
   */
  api.get("/readyz", async (_req, res) => {
    if (!db) {
      res.status(200).type("text/plain").send("ready");
      return;
    }
    try {
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`SELECT 1`);
    } catch {
      res.status(503).type("text/plain").send("db unreachable");
      return;
    }
    if (opts.deploymentMode === "authenticated" && !opts.authReady) {
      res.status(503).type("text/plain").send("auth not ready");
      return;
    }
    res.status(200).type("text/plain").send("ready");
  });

  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use("/companies", hireProposalRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
  }));
  api.use(routineRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(departmentRoutes(db));
  api.use(departmentStatusRoutes(db));
  api.use(experimentRoutes(db));
  api.use(funnelRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  api.use(instanceInvitesRoutes(db));
  api.use(templateRoutes(db));
  api.use(integrationRoutes(db));
  api.use(integrationHealthRoutes(db));
  api.use(insightRoutes(db));
  api.use(postHogRoutes(db));
  api.use(oauthRoutes(db));
  api.use(companyMemoryRoutes(db));
  api.use(conversationRoutes(db));
  api.use(integrationDataRoutes(db));
  api.use(agentReviewRoutes(db));
  api.use(companyProviderRoutes(db));
  api.use(decisionOutcomeRoutes(db));
  api.use(weeklyWrapRoutes(db));
  api.use(dailyBriefRoutes(db));
  api.use(permissionCoachRoutes(db));
  api.use(agentHandoffRoutes(db));
  api.use(composioRoutes(db));
  api.use(debugRoutes());
  api.use("/billing", billingRoutes(db));
  api.use(stripeBackfillRoutes());
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(byoKeyRoutes(db));
  // Token-management surface — issuance, revoke, status. Gated by the same
  // flag as the runner-job surface so a half-flipped deploy can't expose
  // token issuance without the runner endpoints existing.
  if (isByoRunnerEnabled()) {
    api.use(runnerTokenManagementRoutes(db));
  }
  api.use(digestRoutes(db, { publicUrl: process.env.FOUNDEROS_PUBLIC_URL }));
  api.use(onboardingRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        res.status(200).set("Content-Type", "text/html").end(indexHtml);
      });
    } else {
      console.warn("[founderos] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        // Explicitly allow the tunnel + lan hosts — Vite otherwise restricts to localhost.
        // `true` disables the host check entirely (acceptable because the server sits
        // behind auth + CORS + the overall deployment-mode gate).
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : true,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = applyUiBranding(await vite.transformIndexHtml(req.originalUrl, template));
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(sentryErrorHandler);
  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  createDailyDigestCron({
    db,
    emailSender: createEmailSender({
      apiKey: process.env.RESEND_API_KEY,
      fromAddress: process.env.EMAIL_FROM,
    }),
    publicUrl: process.env.FOUNDEROS_PUBLIC_URL,
  }).start();
  const decisionFollowupCron = createDecisionFollowupCron({ db });
  decisionFollowupCron.start();
  const weeklyWrapDeliveryCron = createWeeklyWrapDeliveryCron({
    db,
    emailSender: createEmailSender({
      apiKey: process.env.RESEND_API_KEY,
      fromAddress: process.env.EMAIL_FROM,
    }),
    publicUrl: process.env.FOUNDEROS_PUBLIC_URL,
  });
  weeklyWrapDeliveryCron.start();
  const linkedinSyncCron = createLinkedInSyncCron({ db });
  linkedinSyncCron.start();
  const dailyFounderBriefCron = createDailyFounderBriefCron({ db });
  dailyFounderBriefCron.start();
  const feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      runInCronContext("feedback-export-flush", () => {
        void opts.feedbackExportService?.flushPendingFeedbackTraces().catch((err) => {
          logger.error({ err }, "Failed to flush pending feedback exports");
        });
      });
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void opts.feedbackExportService.flushPendingFeedbackTraces().catch((err) => {
      logger.error({ err }, "Failed to flush pending feedback exports");
    });
  }
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    if (feedbackExportTimer) clearInterval(feedbackExportTimer);
    decisionFollowupCron.stop();
    weeklyWrapDeliveryCron.stop();
    linkedinSyncCron.stop();
    dailyFounderBriefCron.stop();
    devWatcher?.close();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
