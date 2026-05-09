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
 *   FOUNDEROS_DISPATCHER_V2      — opt-OUT switch for the PHASE-S7
 *                                   multi-provider dispatcher path (Gemini,
 *                                   Codex, Cursor, OpenCode, …). Default is
 *                                   ON (V2). Set to "0" | "false" | "no"
 *                                   (case-insensitive, trimmed) to revert to
 *                                   the legacy `runClaude` path. PRs
 *                                   #107/#110/#112/#113/#116/#118 baked the
 *                                   adapters; V2 is now the safe default.
 *                                   Rollback: `fly secrets set
 *                                   FOUNDEROS_DISPATCHER_V2=0`.
 *                                   See docs/runbooks/dispatcher-v2-rollout.md.
 */

// Hand-rolled to avoid CodeQL js/polynomial-redos on regex-over-untrusted-input.
function isValidRunnerToken(token: string): boolean {
  if (token.length !== 36) return false;
  if (!token.startsWith("fos_")) return false;
  for (let i = 4; i < 36; i++) {
    const c = token.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    if (!isDigit && !isUpper && !isLower) return false;
  }
  return true;
}

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
 * Optional overrides for `loadConfig`. Used by the CLI to thread parsed
 * `--token` / `--server-url` flags through. When a key is non-empty, it
 * takes precedence over the matching env var. When omitted or empty,
 * the env var is consulted.
 *
 * v0.1.1 (2026-05-07) — added so Windows PowerShell users don't have
 * to fight `$env:FOUNDEROS_RUNNER_TOKEN="..."` to start the runner;
 * `npx @founderos/runner start --token=fos_... --server-url=...`
 * works inline.
 */
export interface RunnerConfigOverrides {
  serverUrl?: string;
  token?: string;
  claudeBin?: string;
  defaultTimeoutSec?: number;
  logLevel?: string;
}

/**
 * Read config from process.env, with optional flag-based overrides.
 * Throws RunnerConfigError with a hint when a required var is missing
 * or malformed — caller prints to stderr and exits.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: RunnerConfigOverrides = {},
): RunnerConfig {
  const serverUrl = (overrides.serverUrl ?? env.FOUNDEROS_RUNNER_URL ?? "").trim();
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

  const token = (overrides.token ?? env.FOUNDEROS_RUNNER_TOKEN ?? "").trim();
  if (!isValidRunnerToken(token)) {
    throw new RunnerConfigError(
      "FOUNDEROS_RUNNER_TOKEN is required and must match fos_<32 alphanumeric>. Issue one from the FounderOS dashboard.",
    );
  }

  const claudeBin = (overrides.claudeBin ?? env.FOUNDEROS_CLAUDE_BIN ?? "claude").trim();

  const rawTimeout =
    overrides.defaultTimeoutSec != null
      ? String(overrides.defaultTimeoutSec)
      : (env.FOUNDEROS_RUNNER_TIMEOUT_SEC ?? "").trim();
  const defaultTimeoutSec = rawTimeout ? Number(rawTimeout) : 600;
  if (!Number.isFinite(defaultTimeoutSec) || defaultTimeoutSec < 1 || defaultTimeoutSec > 3600) {
    throw new RunnerConfigError(
      `FOUNDEROS_RUNNER_TIMEOUT_SEC must be 1..3600 seconds; got ${rawTimeout || "(empty)"}`,
    );
  }

  const rawLevel = (overrides.logLevel ?? env.FOUNDEROS_RUNNER_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (rawLevel !== "debug" && rawLevel !== "info" && rawLevel !== "warn" && rawLevel !== "error") {
    throw new RunnerConfigError(
      `FOUNDEROS_RUNNER_LOG_LEVEL must be debug|info|warn|error; got ${rawLevel}`,
    );
  }

  // Trim trailing slashes so route concatenation is predictable.
  // Hand-rolled to avoid CodeQL js/polynomial-redos on regex-over-untrusted-input —
  // serverUrl came from env / CLI flag, both of which CodeQL flags as library input.
  let trimEnd = serverUrl.length;
  while (trimEnd > 0 && serverUrl.charCodeAt(trimEnd - 1) === 47 /* '/' */) {
    trimEnd -= 1;
  }
  const normalizedUrl = trimEnd === serverUrl.length ? serverUrl : serverUrl.slice(0, trimEnd);

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
 * Default: ON (V2 multi-adapter dispatcher). Opt-out values: "0", "false",
 * "no" (case-insensitive, trimmed) revert to the legacy `runClaude` path.
 * Anything else — including unset, empty string, "1", "true", arbitrary
 * strings — keeps V2 ON. Inverted from the original opt-in default in
 * task #50 once PRs #107 (interface), #110 (dispatcher), #112 (main swap),
 * #113 (claude lifecycle), #116 (gemini), #118 (codex) all baked in prod.
 * Rollback escape hatch: `fly secrets set FOUNDEROS_DISPATCHER_V2=0`.
 *
 * Caller convention: use this helper instead of re-parsing the env var,
 * so the opt-out set stays single-sourced.
 */
export function isDispatcherV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.FOUNDEROS_DISPATCHER_V2 ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}
