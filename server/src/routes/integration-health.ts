/**
 * Connector health + KPI freshness routes (S2.7).
 *
 * GET /api/integrations/health?companyId=<id>
 *   Returns health status for all 6 tracked sources. Sources with no
 *   composio_connections row return status: 'never_connected'.
 *
 * GET /api/companies/:id/kpi-freshness
 *   Returns per-KPI last-sync timestamps keyed by metric name. Sources that
 *   are not connected return null for that KPI.
 */

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** All 6 sources the health grid tracks. Order is stable for UI rendering. */
const HEALTH_SOURCES = [
  "stripe",
  "posthog",
  "linkedin",
  "notion",
  "slack",
  "hubspot",
] as const;
type HealthSource = (typeof HEALTH_SOURCES)[number];

/** External-facing health status for a single connector. */
export type ConnectorHealth = {
  source: HealthSource;
  /** connected: last sync ok/partial; syncing: in-flight; failed: consecutive failures; never_connected: no row */
  status: "connected" | "syncing" | "failed" | "never_connected";
  lastSync: string | null;
  lastError: string | null;
  retryAvailable: boolean;
};

/** Per-KPI freshness payload. null means the source is not connected. */
export type KpiFreshness = {
  mrr: { sourceLastSync: string | null } | null;
  arr: { sourceLastSync: string | null } | null;
  signups: { sourceLastSync: string | null } | null;
  pipeline: { sourceLastSync: string | null } | null;
  burn: { sourceLastSync: string | null } | null;
  runway: { sourceLastSync: string | null } | null;
};

/** Map each KPI to the source connector that provides it. */
const KPI_SOURCE_MAP: Record<keyof KpiFreshness, HealthSource> = {
  mrr: "stripe",
  arr: "stripe",
  signups: "posthog",
  pipeline: "hubspot",
  burn: "stripe",
  runway: "stripe",
};

function deriveStatus(row: {
  lastSyncStatus: string | null;
  consecutiveFailures: number;
}): ConnectorHealth["status"] {
  if (row.lastSyncStatus === "syncing") return "syncing";
  if (row.lastSyncStatus === "fail" || row.consecutiveFailures > 0) return "failed";
  if (row.lastSyncStatus === "ok" || row.lastSyncStatus === "partial") return "connected";
  // Row exists but no sync attempted yet — OAuth complete, treat as connected.
  return "connected";
}

export function integrationHealthRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/integrations/health?companyId=<id>
   *
   * Returns all 6 source cards; missing rows become never_connected.
   * Board auth + company access required.
   */
  router.get("/integrations/health", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    if (!companyId) {
      res.status(400).json({ error: "companyId query param required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.companyId, companyId),
          inArray(composioConnections.appName, HEALTH_SOURCES as unknown as string[]),
        ),
      );

    // Index by appName for O(1) lookup.
    const bySource = new Map(rows.map((r) => [r.appName, r]));

    const health: ConnectorHealth[] = HEALTH_SOURCES.map((source) => {
      const row = bySource.get(source);
      if (!row) {
        return {
          source,
          status: "never_connected" as const,
          lastSync: null,
          lastError: null,
          retryAvailable: false,
        };
      }
      const status = deriveStatus(row);
      return {
        source,
        status,
        lastSync: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        lastError: row.lastError,
        retryAvailable: status === "failed",
      };
    });

    res.json(health);
  });

  /**
   * GET /api/companies/:id/kpi-freshness
   *
   * Returns lastSyncAt timestamps keyed by KPI name. Null when the
   * source connector is not connected. Board auth + company access required.
   */
  router.get("/companies/:id/kpi-freshness", async (req, res) => {
    const companyId = req.params.id as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    // Fetch all sources we need in one query.
    const neededSources = [...new Set(Object.values(KPI_SOURCE_MAP))];
    const rows = await db
      .select()
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.companyId, companyId),
          inArray(composioConnections.appName, neededSources),
        ),
      );

    const bySource = new Map(rows.map((r) => [r.appName, r]));

    const freshness = {} as KpiFreshness;
    for (const [kpi, source] of Object.entries(KPI_SOURCE_MAP) as [keyof KpiFreshness, HealthSource][]) {
      const row = bySource.get(source);
      freshness[kpi] = row
        ? { sourceLastSync: row.lastSyncAt ? row.lastSyncAt.toISOString() : null }
        : null;
    }

    res.json(freshness);
  });

  return router;
}
