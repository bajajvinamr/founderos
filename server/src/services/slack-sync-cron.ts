/**
 * Slack Sync Cron (S2.6)
 *
 * Every 30 minutes, syncs messages from channels the bot is in for all
 * workspaces with active Slack connections. Ingests messages (last 24h)
 * as normalized events with PII redaction.
 *
 * Design notes:
 *   - setInterval-based, unref'd for graceful shutdown.
 *   - Idempotent: deduplication happens at the event-ingest layer.
 *   - Errors per workspace are logged but don't block other syncs.
 *   - PII redaction (email regex) is applied before storage.
 */

import type { Db } from "@founderos/db";
import { and, eq, not, isNull } from "drizzle-orm";
import { composioConnections } from "@founderos/db";
import { ingestSlackMessages } from "./integrations/slack-ingest.js";
import { logger } from "../middleware/logger.js";
import { runCronTick } from "../lib/cron-tick.js";

/** Cron tick cadence: every 30 minutes. */
export const DEFAULT_TICK_INTERVAL_MS = 30 * 60 * 1_000;

export interface SlackSyncCronOptions {
  db: Db;
  /** Override tick cadence in ms. Defaults to 30min. */
  tickIntervalMs?: number;
}

export interface SlackSyncCron {
  /** Start the interval. Also fires one immediate tick. */
  start: () => void;
  /** Stop the interval. Safe to call more than once. */
  stop: () => void;
  /** Run a single tick synchronously — useful for tests and manual triggers. */
  runOnce: () => Promise<{ synced: number; failed: number }>;
}

export function createSlackSyncCron(opts: SlackSyncCronOptions): SlackSyncCron {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const { db } = opts;

  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<{ synced: number; failed: number }> {
    try {
      // Find all workspaces with active Slack connections.
      // A workspace is "active" if it has a composio_connection row with app: 'slack'.
      const connections = await db
        .select({
          workspaceId: composioConnections.userId,
          connectedAccountId: composioConnections.composioConnectionId,
          companyId: composioConnections.companyId,
        })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.appName, "slack"),
            not(isNull(composioConnections.composioConnectionId)),
          ),
        );

      if (connections.length === 0) {
        logger.debug("slack-sync-cron: no active Slack connections");
        return { synced: 0, failed: 0 };
      }

      let synced = 0;
      let failed = 0;

      for (const conn of connections) {
        try {
          await ingestSlackMessages(db, {
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
            "slack-sync-cron: sync failed for workspace",
          );
          failed++;
        }
      }

      logger.info(
        { synced, failed, total: connections.length },
        "slack-sync-cron: tick completed",
      );

      return { synced, failed };
    } catch (err) {
      logger.error({ err }, "slack-sync-cron: tick failed");
      return { synced: 0, failed: 0 };
    }
  }

  function start(): void {
    if (timer) return;
    // PR-5 (council 2026-05-07 P1): wrap in runCronTick — adds cron
    // requestId/traceId/actor to logs from inside runOnce() and routes
    // uncaught throws to Sentry via captureServerError.
    // Fire once immediately so we don't wait a full tick after boot.
    void runCronTick("slack-sync", runOnce);
    timer = setInterval(() => {
      void runCronTick("slack-sync", runOnce);
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
