/**
 * Runner config loader. v0.1 — env-only. TOML file support deferred to v0.2.
 *
 * Required (no fallbacks; runner refuses to start without):
 *   FOUNDEROS_RUNNER_URL    — cloud base URL, e.g. https://founderos.fly.dev
 *   FOUNDEROS_RUNNER_TOKEN  — bearer token issued by the cloud, fos_<32>
 *
 * Optional:
 *   FOUNDEROS_CLAUDE_BIN    — path to claude CLI (default: "claude" on PATH)
 *   FOUNDEROS_RUNNER_TIMEOUT_SEC — per-job ceiling, default 600
 *   FOUNDEROS_RUNNER_LOG_LEVEL   — debug | info | warn | error (default: info)
 *   FOUNDEROS_DISPATCHER_V2      — when truthy ("1" | "true" | "yes",
 *                                   case-insensitive) opts the runner into the
 *                                   PHASE-S7 multi-provider dispatcher path
 *                                   (Gemini, Codex, Cursor, OpenCode, …).
 *                                   Absence = safe default = legacy `runClaude`.
 *                                   See docs/runbooks/dispatcher-v2-rollout.md.
 */

const TOKEN_FORMAT = /^fos_[A-Za-z0-9]{32}$/;

export interface RunnerConfig {
  serverUrl: string;
  token: string;
  claudeBin: string;
  defaultTimeoutSec: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

/**
 * Read config from process.env. Throws RunnerConfigError with a hint when
 * a required var is missing or malformed — caller prints to stderr and exits.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const serverUrl = (env.FOUNDEROS_RUNNER_URL ?? "").trim();
  if (!serverUrl) {
    throw new RunnerConfigError(
      "FOUNDEROS_RUNNER_URL is required. Example: export FOUNDEROS_RUNNER_URL=https://founderos.fly.dev",
    );
  }
  // Reject anything that isn't a valid http/https URL — keeps log/argv
  // injection vectors out of the request path.
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new RunnerConfigError(`FOUNDEROS_RUNNER_URL is not a valid URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RunnerConfigError(
      `FOUNDEROS_RUNNER_URL must be http(s); got ${parsed.protocol}`,
    );
  }

  const token = (env.FOUNDEROS_RUNNER_TOKEN ?? "").trim();
  if (!TOKEN_FORMAT.test(token)) {
    throw new RunnerConfigError(
      "FOUNDEROS_RUNNER_TOKEN is required and must match fos_<32 alphanumeric>. Issue one from the FounderOS dashboard.",
    );
  }

  const claudeBin = (env.FOUNDEROS_CLAUDE_BIN ?? "claude").trim();

  const rawTimeout = (env.FOUNDEROS_RUNNER_TIMEOUT_SEC ?? "").trim();
  const defaultTimeoutSec = rawTimeout ? Number(rawTimeout) : 600;
  if (!Number.isFinite(defaultTimeoutSec) || defaultTimeoutSec < 1 || defaultTimeoutSec > 3600) {
    throw new RunnerConfigError(
      `FOUNDEROS_RUNNER_TIMEOUT_SEC must be 1..3600 seconds; got ${rawTimeout || "(empty)"}`,
    );
  }

  const rawLevel = (env.FOUNDEROS_RUNNER_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (rawLevel !== "debug" && rawLevel !== "info" && rawLevel !== "warn" && rawLevel !== "error") {
    throw new RunnerConfigError(
      `FOUNDEROS_RUNNER_LOG_LEVEL must be debug|info|warn|error; got ${rawLevel}`,
    );
  }

  // Trim trailing slash so route concatenation is predictable.
  const normalizedUrl = serverUrl.replace(/\/+$/, "");

  return {
    serverUrl: normalizedUrl,
    token,
    claudeBin,
    defaultTimeoutSec,
    logLevel: rawLevel,
  };
}

/**
 * PHASE-S7 dispatcher feature flag.
 *
 * Truthy values: "1", "true", "yes" (case-insensitive, trimmed). Anything
 * else — including unset, empty string, "0", "false" — means the legacy
 * `runClaude` path is used. Absence MUST be the safe default; downstream
 * tickets S7.A.1..S7.D.6 wire the multi-adapter dispatcher behind this
 * gate so it can be flipped/rolled back via `fly secrets`.
 *
 * Caller convention: use this helper instead of re-parsing the env var,
 * so the truthy set stays single-sourced.
 */
export function isDispatcherV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.FOUNDEROS_DISPATCHER_V2 ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
