import path from "node:path";
import {
  TelemetryClient,
  resolveTelemetryConfig,
  loadOrCreateState,
} from "@founderos/shared/telemetry";
import type { Db } from "@founderos/db";
import { instanceSettingsService } from "./services/instance-settings.js";
import { resolveFounderOSInstanceRoot } from "./home-paths.js";
import { serverVersion } from "./version.js";
import { logger } from "./middleware/logger.js";

let client: TelemetryClient | null = null;
let bootFileConfigEnabled: boolean | undefined;

function buildClient(enabled: boolean): TelemetryClient | null {
  const config = resolveTelemetryConfig({ enabled });
  if (!config.enabled) return null;
  const stateDir = path.join(resolveFounderOSInstanceRoot(), "telemetry");
  const c = new TelemetryClient(
    config,
    () => loadOrCreateState(stateDir, serverVersion),
    serverVersion,
  );
  c.startPeriodicFlush(60_000);
  return c;
}

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  if (client) return client;
  bootFileConfigEnabled = fileConfig?.enabled === true;
  client = buildClient(bootFileConfigEnabled);
  return client;
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}

/**
 * Council 2026-05-05 P2 (C1) — re-initialize the telemetry client from
 * persisted instance-settings consent, OR-d with the boot-time file config.
 *
 * Trust contract: the onboarding wizard and /settings/general toggle write
 * `instance_settings.general.telemetryConsent.enabled` to the DB. Without this
 * function the writes are cosmetic — the runtime client only ever read from
 * the file config at boot. Now boot proceeds with file-config-only state,
 * then this hydration runs once after the DB is ready, and it runs again on
 * every successful PATCH to instance settings.
 *
 * Effective enabled = fileBoot || dbConsent. Either path can grant consent;
 * neither path can silently revoke an existing file-config opt-in (operators
 * must remove the file flag explicitly).
 */
export async function reinitTelemetryFromInstanceSettings(db: Db): Promise<void> {
  const fileEnabled = bootFileConfigEnabled === true;
  let dbEnabled = false;
  try {
    const general = await instanceSettingsService(db).getGeneral();
    dbEnabled = general.telemetryConsent?.enabled === true;
  } catch (err) {
    logger.warn(
      { err },
      "telemetry: failed to read instance-settings consent — keeping current client state",
    );
    return;
  }

  const effective = fileEnabled || dbEnabled;

  if (client && !effective) {
    try {
      client.stop();
    } catch (err) {
      logger.warn({ err }, "telemetry: error stopping client during reinit");
    }
    client = null;
    logger.info("telemetry: client stopped (no consent)");
    return;
  }

  if (!client && effective) {
    client = buildClient(true);
    logger.info({ source: dbEnabled ? "instance-settings" : "file-config" }, "telemetry: client started");
    return;
  }
}
