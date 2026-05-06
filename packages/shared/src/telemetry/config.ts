import type { TelemetryConfig } from "./types.js";

const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];

function isCI(): boolean {
  return CI_ENV_VARS.some((key) => process.env[key] === "true" || process.env[key] === "1");
}

/**
 * Resolve runtime telemetry consent. Default is OFF (council 2026-05-05 P1
 * fix) — the landing page promises "no telemetry unless you flip it on",
 * so a fresh install MUST NOT post anything to the ingest endpoint until
 * an operator has explicitly opted in. The opt-in flows through the
 * onboarding consent step and the /settings/general admin toggle, both
 * of which persist `enabled: true` in the file/db config.
 *
 * Hard kill switches (ENV) still win over consent — `FOUNDEROS_TELEMETRY_DISABLED=1`
 * and `DO_NOT_TRACK=1` force OFF even if the operator opted in. CI runs
 * also force OFF so test fleets don't pollute production telemetry.
 */
export function resolveTelemetryConfig(fileConfig?: { enabled?: boolean }): TelemetryConfig {
  if (process.env.FOUNDEROS_TELEMETRY_DISABLED === "1") {
    return { enabled: false };
  }
  if (process.env.DO_NOT_TRACK === "1") {
    return { enabled: false };
  }
  if (isCI()) {
    return { enabled: false };
  }
  // Default OFF: telemetry is enabled ONLY when the operator has explicitly
  // opted in (fileConfig.enabled === true). Any other value (undefined, null,
  // false) keeps it off. This mirrors `server/src/config.ts` which now
  // defaults `telemetryEnabled` to false.
  if (fileConfig?.enabled !== true) {
    return { enabled: false };
  }

  const endpoint = process.env.FOUNDEROS_TELEMETRY_ENDPOINT || undefined;
  return { enabled: true, endpoint };
}
