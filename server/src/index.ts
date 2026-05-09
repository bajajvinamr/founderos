/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@founderos/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { runInCronContext } from "./lib/request-context.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  heartbeatService,
  instanceSettingsService,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { validateEnvOrExit } from "./lib/env-validation.js";
import { ensureAgentJwtSecretAtBoot } from "./boot/jwt-secret-bootstrap.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  let config = loadConfig();
  // Bring up Sentry first so uncaught exceptions during the rest of boot
  // get captured. No-op when SENTRY_DSN isn't set.
  const { initServerSentry } = await import("./observability/sentry.js");
  const sentryUp = await initServerSentry();
  if (sentryUp) logger.info("Sentry initialized");
  initTelemetry({ enabled: config.telemetryEnabled });
  // Auto-bootstrap FOUNDEROS_AGENT_JWT_SECRET in dev/test so a fresh
  // checkout doesn't trip 401 on first agent run. In production this is a
  // no-op (env-validation.ts hard-fails the boot when the secret is missing
  // under strict mode); the bootstrap module's defensive throw is
  // belt-and-suspenders for any path that bypasses validateEnvOrExit.
  // MUST run AFTER loadConfig() (which loads dotenv from ~/.founderos/.env
  // and CWD/.env) and BEFORE validateEnvOrExit() so prod's hard-fail
  // signal is preserved when someone explicitly unsets the secret.
  try {
    const bootstrap = ensureAgentJwtSecretAtBoot();
    if (bootstrap.created) {
      logger.warn(
        { envFilePath: bootstrap.envFilePath },
        "[founderos] Auto-generated FOUNDEROS_AGENT_JWT_SECRET in dev. " +
          "In production, set this explicitly via fly secrets / env.",
      );
    } else if (bootstrap.loadedFromFile) {
      logger.info(
        { envFilePath: bootstrap.envFilePath },
        "[founderos] Loaded FOUNDEROS_AGENT_JWT_SECRET from env file at boot",
      );
    }
  } catch (err) {
    // In production this re-throws and lets the index.ts top-level catch
    // exit cleanly. In dev (where the throw is impossible), this catch is
    // dead code — no behavior change.
    logger.fatal({ err }, "Agent JWT secret bootstrap failed");
    throw err;
  }
  // Loud-fail env validation. In production: hard-exit if a REQUIRED gate
  // is missing. In dev/local_trusted: warn + continue. Runs AFTER dotenv
  // merging in loadConfig() so .env files are already loaded.
  validateEnvOrExit({
    strict: process.env.NODE_ENV === "production",
    logger,
  });
  if (process.env.FOUNDEROS_SECRETS_PROVIDER === undefined) {
    process.env.FOUNDEROS_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.FOUNDEROS_SECRETS_STRICT_MODE === undefined) {
    process.env.FOUNDEROS_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.FOUNDEROS_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.FOUNDEROS_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.FOUNDEROS_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.FOUNDEROS_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set FOUNDEROS_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set FOUNDEROS_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@founderos.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    const allCompanyIds = companyRows.map((r: { id: string }) => r.id);
    if (allCompanyIds.length > 0) {
      const existingMemberships = await db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            inArray(companyMemberships.companyId, allCompanyIds),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        );
      const existingSet = new Set(existingMemberships.map((r: { companyId: string }) => r.companyId));
      const missing = allCompanyIds.filter((id: string) => !existingSet.has(id));
      if (missing.length > 0) {
        await db.insert(companyMemberships).values(
          missing.map((companyId: string) => ({
            companyId,
            principalType: "user" as const,
            principalId: LOCAL_BOARD_USER_ID,
            status: "active" as const,
            membershipRole: "owner" as const,
          })),
        );
      }
    }
  }
  
  let db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.FOUNDEROS_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://founderos:founderos@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "founderos");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "founderos",
          password: "founderos",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://founderos:founderos@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "founderos");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: founderos");
    }
  
    const embeddedConnectionString = `postgres://founderos:founderos@127.0.0.1:${port}/founderos`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  const { assertDeploymentModeSafety } = await import("./lib/deployment-mode-guards.js");
  assertDeploymentModeSafety({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    host: config.host,
    strictCompanyIsolation: process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION,
  });

  // Hydrate DB-stored provider API keys into process.env so adapter
  // subprocesses inherit them without per-adapter plumbing.
  try {
    const { instanceApiKeysService } = await import("./services/instance-api-keys.js");
    const svc = instanceApiKeysService(db as any);
    const loaded = await svc.hydrateProcessEnv();
    if (loaded > 0) logger.info({ providerKeysLoaded: loaded }, "Hydrated provider API keys into env");
  } catch (err) {
    logger.warn({ err }, "Failed to hydrate provider API keys — agents may fall back to env vars");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    // Supabase JWTs are stateless — there's no server-side callback URL that
    // needs matching. The explicit-baseUrl gate is only required for the
    // better-auth + Clerk paths where cookies + callback flows must pin a
    // canonical origin. Skip the check when the Supabase path is active.
    if (config.deploymentExposure === "public" && config.authProvider !== "supabase") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }

  // Council 2026-05-05 P2 (C1) — hydrate telemetry runtime state from
  // persisted instance-settings consent after DB is ready. Without this the
  // wizard / settings toggle is cosmetic: writes land in the DB but never
  // reach the telemetry client. See server/src/telemetry.ts for the
  // re-init contract (file-config OR DB-consent → enabled).
  try {
    const { reinitTelemetryFromInstanceSettings } = await import("./telemetry.js");
    await reinitTelemetryFromInstanceSettings(db as any);
  } catch (err) {
    logger.warn({ err }, "telemetry: instance-settings hydration failed at boot — keeping file-config state");
  }

  let authProvider: "clerk" | "better-auth" | "local_trusted" | "supabase" = "local_trusted";
  let authPublishableKey: string | undefined;
  let authSupabaseAnonKey: string | undefined;
  let authSupabaseUrl: string | undefined;
  let supabaseWebhookSecret: string | undefined;
  if (config.deploymentMode === "authenticated") {
    const { isClerkEnabled } = await import("./auth/clerk.js");
    // Supabase has explicit opt-in via FOUNDEROS_AUTH_PROVIDER=supabase. It
    // takes precedence over Clerk env detection so ops can switch providers
    // without nuking CLERK_* keys from the environment.
    if (config.authProvider === "supabase") {
      const { createSupabaseAuth, isSupabaseConfigured, resolveSupabaseSession, resolveSupabaseSessionFromHeaders } =
        await import("./auth/supabase.js");
      if (!isSupabaseConfigured(config.supabase)) {
        throw new Error(
          "FOUNDEROS_AUTH_PROVIDER=supabase requires SUPABASE_URL to be set. " +
          "JWKS is auto-fetched from <SUPABASE_URL>/auth/v1/.well-known/jwks.json.",
        );
      }
      const supabaseAuth = createSupabaseAuth(config.supabase);
      resolveSession = (req) => resolveSupabaseSession(supabaseAuth, req);
      resolveSessionFromHeaders = (headers) => resolveSupabaseSessionFromHeaders(supabaseAuth, headers);
      authProvider = "supabase";
      authSupabaseAnonKey = config.supabase.anonKey;
      authSupabaseUrl = config.supabase.url;
      supabaseWebhookSecret = config.supabase.webhookSecret;
      authReady = true;
      logger.info(
        {
          authProvider,
          hasUrl: Boolean(config.supabase.url),
          hasAnonKey: Boolean(config.supabase.anonKey),
          hasWebhookSecret: Boolean(config.supabase.webhookSecret),
        },
        "Authenticated mode: using Supabase",
      );
    } else if (isClerkEnabled()) {
      // Clerk path — production default when CLERK_* env vars are set.
      const { createClerkAuth, resolveClerkSession } = await import("./auth/clerk.js");
      const clerk = createClerkAuth();
      resolveSession = (req) => resolveClerkSession(clerk, req);
      // Websocket session resolution from headers (API clients passing
      // `Authorization: Bearer`): convert headers → minimal Request.
      resolveSessionFromHeaders = async (headers) => {
        const fakeReq = {
          headers: Object.fromEntries(headers.entries()),
          protocol: "http",
          originalUrl: "/",
          url: "/",
        } as unknown as ExpressRequest;
        return resolveClerkSession(clerk, fakeReq);
      };
      authProvider = "clerk";
      authPublishableKey = clerk.publishableKey;
      authReady = true;
      logger.info({ authProvider }, "Authenticated mode: using Clerk");
    } else {
      // Legacy better-auth path — kept for backward-compat with existing
      // accounts and dev setups that didn't migrate.
      const {
        createBetterAuthHandler,
        createBetterAuthInstance,
        deriveAuthTrustedOrigins,
        resolveBetterAuthSession,
        resolveBetterAuthSessionFromHeaders,
      } = await import("./auth/better-auth.js");
      const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
      const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
      logger.info(
        {
          authProvider: "better-auth",
          authBaseUrlMode: config.authBaseUrlMode,
          authPublicBaseUrl: config.authPublicBaseUrl ?? null,
          trustedOrigins: effectiveTrustedOrigins,
          trustedOriginsSource: {
            derived: derivedTrustedOrigins.length,
            env: envTrustedOrigins.length,
          },
        },
        "Authenticated mode auth origin configuration",
      );
      const { createEmailSender } = await import("./services/email-sender.js");
      const emailSender = createEmailSender({
        apiKey: process.env.RESEND_API_KEY,
        fromAddress: process.env.EMAIL_FROM,
      });
      const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins, emailSender);
      betterAuthHandler = createBetterAuthHandler(auth);
      resolveSession = (req) => resolveBetterAuthSession(auth, req);
      resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
      await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
      authProvider = "better-auth";
      authReady = true;
    }
  }
  // Make auth metadata readable by the app layer for /api/auth/config.
  (config as unknown as { authProvider?: typeof authProvider; authPublishableKey?: string })
    .authProvider = authProvider;
  (config as unknown as { authProvider?: typeof authProvider; authPublishableKey?: string })
    .authPublishableKey = authPublishableKey;
  
  const listenPort = await detectPort(config.port);
  if (listenPort !== config.port) {
    config.port = listenPort;
  }
  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
    authProvider,
    authPublishableKey,
    authSupabaseAnonKey,
    authSupabaseUrl,
    supabaseWebhookSecret,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.FOUNDEROS_LISTEN_HOST = runtimeListenHost;
  process.env.FOUNDEROS_LISTEN_PORT = String(listenPort);
  process.env.FOUNDEROS_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });
  
  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const routines = routineService(db as any);
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
      .then(() => heartbeat.resumeQueuedRuns())
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
    setInterval(() => {
      // Council 2026-05-03 P2 — wrap each scheduler tick body in a fresh
      // ALS context so logs and Sentry events from heartbeat/routine
      // bookkeeping carry a requestId/traceId. Without this the pino mixin
      // and Sentry scope-enrichment silently emitted empty correlation
      // tags for every scheduled run, breaking incident-triage on the
      // background path.
      runInCronContext("heartbeat-tick", () => {
        void heartbeat
          .tickTimers(new Date())
          .then((result) => {
            if (result.enqueued > 0) {
              logger.info({ ...result }, "heartbeat timer tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "heartbeat timer tick failed");
          });
      });

      runInCronContext("routine-scheduler-tick", () => {
        void routines
          .tickScheduledTriggers(new Date())
          .then((result) => {
            if (result.triggered > 0) {
              logger.info({ ...result }, "routine scheduler tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "routine scheduler tick failed");
          });
      });

      runInCronContext("heartbeat-reap-orphans", () => {
        // Periodically reap orphaned runs (5-min staleness threshold) and
        // drive persisted queued work forward.
        void heartbeat
          .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
          .then(() => heartbeat.resumeQueuedRuns())
          .catch((err) => {
            logger.error({ err }, "periodic heartbeat recovery failed");
          });
      });
    }, config.heartbeatSchedulerIntervalMs);
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    const settingsSvc = instanceSettingsService(db);
    let backupInFlight = false;

    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }

      backupInFlight = true;
      try {
        // Read retention from Instance Settings (DB) so changes take effect without restart
        const generalSettings = await settingsSvc.getGeneral();
        const retention = generalSettings.backupRetention;

        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retention,
          filenamePrefix: "founderos",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retention,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      runInCronContext("database-backup", () => {
        void runScheduledBackup();
      });
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters, registerByoRunnerAdapter } = await import(
    "./adapters/registry.js"
  );
  await waitForExternalAdapters();

  // BYO Runner (ADR-011, BYO-103): conditional registration. The adapter
  // type is in BUILTIN_ADAPTER_TYPES so existing rows validate, but the
  // execute() path is only mounted when the flag is on.
  const { isByoRunnerEnabled } = await import("./lib/byo-runner-flag.js");
  if (isByoRunnerEnabled()) {
    registerByoRunnerAdapter(db);
    logger.info("[byo-runner] adapter registered (FOUNDEROS_BYO_RUNNER_ENABLED=1)");
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.FOUNDEROS_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
        printStartupBanner({
          bind: config.bind,
          host: config.host,
          deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.FOUNDEROS_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "FounderOS server failed to start");
    process.exit(1);
  });
}
