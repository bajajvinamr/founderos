/**
 * Notion Sync Cron (S2.6)
 *
 * Every 1 hour, syncs accessible Notion pages for all workspaces with
 * active Notion connections. Ingests pages as normalized events.
 *
 * Design notes:
 *   - setInterval-based, unref'd for graceful shutdown.
 *   - Idempotent: deduplication happens at the event-ingest layer.
 *   - Errors per workspace are logged but don't block other syncs.
 */

import type { Db } from "@founderos/db";
import { and, eq, not, isNull } from "drizzle-orm";
import { composioConnections } from "@founderos/db";
import { ingestNotionPages } from "./integrations/notion-ingest.js";
import { logger } from "../middleware/logger.js";

/** Cron tick cadence: every 1 hour. */
export const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1_000;

export interface NotionSyncCronOptions {
  db: Db;
  /** Override tick cadence in ms. Defaults to 1h. */
  tickIntervalMs?: number;
}

export interface NotionSyncCron {
  /** Start the interval. Also fires one immediate tick. */
  start: () => void;
  /** Stop the interval. Safe to call more than once. */
  stop: () => void;
  /** Run a single tick synchronously — useful for tests and manual triggers. */
  runOnce: () => Promise<{ synced: number; failed: number }>;
}

export function createNotionSyncCron(
  opts: NotionSyncCronOptions,
): NotionSyncCron {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const { db } = opts;

  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<{ synced: number; failed: number }> {
    try {
      // Find all workspaces with active Notion connections.
      // A workspace is "active" if it has a composio_connection row with app: 'notion'.
      const connections = await db
        .select({
          workspaceId: composioConnections.workspaceId,
          connectedAccountId: composioConnections.connectedAccountId,
          companyId: composioConnections.companyId,
        })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.app, "notion"),
            not(isNull(composioConnections.connectedAccountId)),
          ),
        );

      if (connections.length === 0) {
        logger.debug("notion-sync-cron: no active Notion connections");
        return { synced: 0, failed: 0 };
      }

      let synced = 0;
      let failed = 0;

      for (const conn of connections) {
        try {
          await ingestNotionPages(db, {
            companyId: conn.companyId,
            workspaceId: conn.workspaceId,
            connectedAccountId: conn.connectedAccountId,
          });
          synced++;
        } catch (err) {
          logger.error(
            {
              err,
              workspaceId: conn.workspaceId,
              companyId: conn.companyId,
            },
            "notion-sync-cron: sync failed for workspace",
          );
          failed++;
        }
      }

      logger.info(
        { synced, failed, total: connections.length },
        "notion-sync-cron: tick completed",
      );

      return { synced, failed };
    } catch (err) {
      logger.error({ err }, "notion-sync-cron: tick failed");
      return { synced: 0, failed: 0 };
    }
  }

  function start(): void {
    if (timer) return;
    // Fire once immediately so we don't wait a full tick after boot.
    void runOnce();
    timer = setInterval(() => {
      void runOnce();
    }, tickIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce };
}
