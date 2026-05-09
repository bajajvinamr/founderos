import { existsSync, readFileSync } from "node:fs";
import { resolveFounderOSConfigPath, resolveFounderOSEnvPath } from "./paths.js";
import type { BindMode, DeploymentExposure, DeploymentMode } from "@founderos/shared";

import { parse as parseEnvFileContents } from "dotenv";

type UiMode = "none" | "static" | "vite-dev";

type ExternalPostgresInfo = {
  mode: "external-postgres";
  connectionString: string;
};

type EmbeddedPostgresInfo = {
  mode: "embedded-postgres";
  dataDir: string;
  port: number;
};

type StartupBannerOptions = {
  bind: BindMode;
  host: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  requestedPort: number;
  listenPort: number;
  uiMode: UiMode;
  db: ExternalPostgresInfo | EmbeddedPostgresInfo;
  migrationSummary: string;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
};

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function color(text: string, c: keyof typeof ansi): string {
  return `${ansi[c]}${text}${ansi.reset}`;
}

function row(label: string, value: string): string {
  return `${color(label.padEnd(16), "dim")} ${value}`;
}

function redactConnectionString(raw: string): string {
  try {
    const u = new URL(raw);
    const user = u.username || "user";
    const auth = `${user}:***@`;
    return `${u.protocol}//${auth}${u.host}${u.pathname}`;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

function resolveAgentJwtSecretStatus(
  envFilePath: string,
): {
  status: "pass" | "warn" | "fail";
  message: string;
} {
  const envValue = process.env.FOUNDEROS_AGENT_JWT_SECRET?.trim();
  if (envValue) {
    return {
      status: "pass",
      message: "configured",
    };
  }

  // Post-2026-05-09 the dev-mode auto-bootstrap (boot/jwt-secret-bootstrap.ts)
  // makes the missing-secret branch unreachable in normal dev/test boot.
  // If we get here, either env-validation.ts already hard-failed (prod) or
  // the bootstrap was bypassed (bug).
  if (process.env.NODE_ENV === "production") {
    return {
      status: "fail",
      message:
        "missing in production — set FOUNDEROS_AGENT_JWT_SECRET via " +
        "`fly secrets set` or your secret manager",
    };
  }

  // Legacy "found in env file but not loaded" signal for the rare case where
  // the env file was created post-boot. Auto-bootstrap is the new happy
  // path; this remains as a fallback diagnostic.
  if (existsSync(envFilePath)) {
    const parsed = parseEnvFileContents(readFileSync(envFilePath, "utf-8"));
    const fileValue =
      typeof parsed.FOUNDEROS_AGENT_JWT_SECRET === "string"
        ? parsed.FOUNDEROS_AGENT_JWT_SECRET.trim()
        : "";
    if (fileValue) {
      return {
        status: "warn",
        message: `found in ${envFilePath} but not loaded into process.env — restart the server`,
      };
    }
  }

  // True fall-through: bootstrap should have generated one. File a bug.
  return {
    status: "warn",
    message: "missing despite auto-bootstrap (file a bug)",
  };
}

export function printStartupBanner(opts: StartupBannerOptions): void {
  const baseHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const baseUrl = `http://${baseHost}:${opts.listenPort}`;
  const apiUrl = `${baseUrl}/api`;
  const uiUrl = opts.uiMode === "none" ? "disabled" : baseUrl;
  const configPath = resolveFounderOSConfigPath();
  const envFilePath = resolveFounderOSEnvPath();
  const agentJwtSecret = resolveAgentJwtSecretStatus(envFilePath);

  const dbMode =
    opts.db.mode === "embedded-postgres"
      ? color("embedded-postgres", "green")
      : color("external-postgres", "yellow");
  const uiMode =
    opts.uiMode === "vite-dev"
      ? color("vite-dev-middleware", "cyan")
      : opts.uiMode === "static"
        ? color("static-ui", "magenta")
        : color("headless-api", "yellow");

  const portValue =
    opts.requestedPort === opts.listenPort
      ? `${opts.listenPort}`
      : `${opts.listenPort} ${color(`(requested ${opts.requestedPort})`, "dim")}`;

  const dbDetails =
    opts.db.mode === "embedded-postgres"
      ? `${opts.db.dataDir} ${color(`(pg:${opts.db.port})`, "dim")}`
      : redactConnectionString(opts.db.connectionString);

  const heartbeat = opts.heartbeatSchedulerEnabled
    ? `enabled ${color(`(${opts.heartbeatSchedulerIntervalMs}ms)`, "dim")}`
    : color("disabled", "yellow");
  const dbBackup = opts.databaseBackupEnabled
    ? `enabled ${color(`(every ${opts.databaseBackupIntervalMinutes}m, keep ${opts.databaseBackupRetentionDays}d)`, "dim")}`
    : color("disabled", "yellow");

  const art = [
    color("██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗     ██╗██████╗ ", "cyan"),
    color("██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██║██╔══██╗", "cyan"),
    color("██████╔╝███████║██████╔╝█████╗  ██████╔╝██║     ██║     ██║██████╔╝", "cyan"),
    color("██╔═══╝ ██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗██║     ██║     ██║██╔═══╝ ", "cyan"),
    color("██║     ██║  ██║██║     ███████╗██║  ██║╚██████╗███████╗██║██║     ", "cyan"),
    color("╚═╝     ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝╚═╝     ", "cyan"),
  ];

  const lines = [
    "",
    ...art,
    color("  ───────────────────────────────────────────────────────", "blue"),
    row("Mode", `${dbMode}  |  ${uiMode}`),
    row("Deploy", `${opts.deploymentMode} (${opts.deploymentExposure})`),
    row("Bind", `${opts.bind} ${color(`(${opts.host})`, "dim")}`),
    row("Auth", opts.authReady ? color("ready", "green") : color("not-ready", "yellow")),
    row("Server", portValue),
    row("API", `${apiUrl} ${color(`(health: ${apiUrl}/health)`, "dim")}`),
    row("UI", uiUrl),
    row("Database", dbDetails),
    row("Migrations", opts.migrationSummary),
    row(
      "Agent JWT",
      agentJwtSecret.status === "pass"
        ? color(agentJwtSecret.message, "green")
        : agentJwtSecret.status === "fail"
          ? color(agentJwtSecret.message, "yellow") // intentionally yellow not red — banner is informational; env-validation already exited
          : color(agentJwtSecret.message, "yellow"),
    ),
    row("Heartbeat", heartbeat),
    row("DB Backup", dbBackup),
    row("Backup Dir", opts.databaseBackupDir),
    row("Config", configPath),
    agentJwtSecret.status === "warn" || agentJwtSecret.status === "fail"
      ? color("  ───────────────────────────────────────────────────────", "yellow")
      : null,
    color("  ───────────────────────────────────────────────────────", "blue"),
    "",
  ];

  console.log(lines.filter((line): line is string => line !== null).join("\n"));
}
