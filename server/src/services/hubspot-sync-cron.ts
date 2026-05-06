/**
 * hubspot-sync-cron.ts — BullMQ recurring sync job for HubSpot (S2.5)
 *
 * Runs every 30 minutes to:
 *   1. Fetch all active HubSpot connections across all workspaces
 *   2. Call hubspotIngestService() for each workspace
 *   3. Log results and failures
 *
 * Non-fatal: if one workspace's sync fails, others still run.
 */

import type { Worker } from "bullmq";
import type { Db } from "@founderos/db";
import { composioConnections, companies } from "@founderos/db";
import { and, eq } from "drizzle-orm";
import { getQueue, QUEUE_NAMES, setupDlqListener } from "../lib/queues.js";
import { hubspotIngestService } from "./integrations/hubspot-ingest.js";
import { logger } from "../middleware/logger.js";
import { runCronTaskWithRethrow } from "../lib/cron-tick.js";

const HUBSPOT_SYNC_INTERVAL_CRON = "*/30 * * * *"; // Every 30 minutes

export interface HubspotSyncCronOptions {
  db: Db;
}

/**
 * Initialize the HubSpot sync cron job.
 * Call once at server startup.
 */
export async function initHubspotSyncCron(opts: HubspotSyncCronOptions): Promise<void> {
  const { db } = opts;
  const queue = getQueue(QUEUE_NAMES.HUBSPOT_INGEST);

  // Set up DLQ listener for failed jobs
  setupDlqListener(QUEUE_NAMES.HUBSPOT_INGEST);

  // Define the repeating job using BullMQ's repeat schedule
  // NOTE: BullMQ uses cron expressions (same as system cron)
  await queue.add(
    "sync-all-workspaces",
    { trigger: "cron" },
    {
      repeat: {
        pattern: HUBSPOT_SYNC_INTERVAL_CRON,
      },
      jobId: "hubspot-sync-all-workspaces-recurring",
    },
  );

  logger.info("HubSpot sync cron initialized (*/30 * * * *)");
}

/**
 * Attach a BullMQ Worker to the HUBSPOT_INGEST queue.
 * Processes both manual and recurring sync jobs.
 */
export async function attachHubspotSyncWorker(db: Db): Promise<Worker> {
  const { Worker } = await import("bullmq");
  const queue = getQueue(QUEUE_NAMES.HUBSPOT_INGEST);

  const worker = new Worker(
    QUEUE_NAMES.HUBSPOT_INGEST,
    async (job) => {
      // ── Job types ────────────────────────────────────────────────────
      // "sync-all-workspaces" — recurring cron or manual trigger
      // (future: "sync-workspace:{companyId}" — manual per-workspace)
      //
      // PR-5b (council 2026-05-07 P1-5b): wrap in runCronTaskWithRethrow
      // — sibling of runCronTick that re-throws after Sentry capture so
      // BullMQ's failed-event + retry/DLQ machinery sees the throw with
      // a cron requestId attached. Without the wrap, log lines and
      // Sentry events from inside syncAllWorkspaces() emit empty
      // requestId/traceId/actor mixin fields.
      return runCronTaskWithRethrow(
        "hubspot-sync",
        async () => {
          if (job.name === "sync-all-workspaces") {
            return syncAllWorkspaces(db);
          }
          throw new Error(`Unknown HubSpot sync job type: ${job.name}`);
        },
        { jobId: job.id, jobName: job.name },
      );
    },
    {
      connection: (queue.client as any).options as any,
      concurrency: 1, // One workspace at a time to avoid thundering herd on Redis
    },
  );

  worker.on("completed", (job) => {
    logger.info(
      { jobId: job.id, jobName: job.name, result: job.returnvalue },
      "HubSpot sync job completed",
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, err },
      "HubSpot sync job failed",
    );
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job implementation
// ─────────────────────────────────────────────────────────────────────────────

interface SyncAllWorkspacesResult {
  workspacesProcessed: number;
  workspacesSkipped: number;
  totalContactsProcessed: number;
  totalDealsProcessed: number;
  errors: Array<{ companyId: string; error: string }>;
}

async function syncAllWorkspaces(db: Db): Promise<SyncAllWorkspacesResult> {
  const result: SyncAllWorkspacesResult = {
    workspacesProcessed: 0,
    workspacesSkipped: 0,
    totalContactsProcessed: 0,
    totalDealsProcessed: 0,
    errors: [],
  };

  try {
    // ── Step 1: Fetch all active HubSpot connections ──────────────────

    const activeConnections = await db
      .select({
        companyId: composioConnections.companyId,
        connectionId: composioConnections.id,
      })
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.appName, "hubspot"),
          eq(composioConnections.status, "active"),
        ),
      );

    logger.info(
      { count: activeConnections.length },
      "HubSpot sync cron: found active connections",
    );

    // ── Step 2: Sync each workspace in sequence ──────────────────────

    for (const conn of activeConnections) {
      try {
        // Council 2026-05-06 R2 P2 — pass the exact connectionId we
        // vetted as active so the service binds to the same row, not
        // an arbitrary status=active row picked by .limit(1) in the
        // service. Multi-admin companies have multiple active rows
        // (different userIds), and re-selection without the ID can
        // sync the same workspace twice in one cron tick.
        const syncResult = await hubspotIngestService({
          companyId: conn.companyId,
          connectionId: conn.connectionId,
          db,
        });

        result.workspacesProcessed++;
        result.totalContactsProcessed += syncResult.contactsProcessed;
        result.totalDealsProcessed += syncResult.dealsProcessed;

        logger.info(
          {
            companyId: conn.companyId,
            contactsProcessed: syncResult.contactsProcessed,
            dealsProcessed: syncResult.dealsProcessed,
            nextSync: syncResult.nextSyncAt,
          },
          "HubSpot sync: workspace processed",
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({
          companyId: conn.companyId,
          error: errorMsg,
        });

        logger.error(
          { companyId: conn.companyId, err },
          "HubSpot sync: workspace failed (non-fatal, continuing)",
        );
      }
    }

    // ── Step 3: Summary ──────────────────────────────────────────────

    logger.info(
      {
        workspacesProcessed: result.workspacesProcessed,
        workspacesSkipped: result.workspacesSkipped,
        totalContactsProcessed: result.totalContactsProcessed,
        totalDealsProcessed: result.totalDealsProcessed,
        errorCount: result.errors.length,
      },
      "HubSpot sync cron: cycle complete",
    );

    return result;
  } catch (err: unknown) {
    logger.error({ err }, "HubSpot sync cron: unrecoverable error");
    throw err;
  }
}
