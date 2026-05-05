/**
 * linkedin-sync-cron.ts — 1-hour recurring LinkedIn sync job
 *
 * Design:
 *   - Recurring job every 1 hour via BullMQ
 *   - Discovers active LinkedIn Composio connections per company
 *   - Processes up to 10 companies concurrently
 *   - Per-company error isolation (Promise.allSettled)
 *   - Logs sync counts and failures
 */

import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import { eq } from "drizzle-orm";
import { linkedinIngestService } from "./integrations/linkedin-ingest.js";
import { logger } from "../middleware/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedInSyncCronOptions {
  db: Db;
}

export interface LinkedInSyncCron {
  start(): void;
  stop(): void;
  tick(): Promise<{
    synced: number;
    failed: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONCURRENT = 10;

export function createLinkedInSyncCron(opts: LinkedInSyncCronOptions): LinkedInSyncCron {
  const { db } = opts;

  let intervalHandle: NodeJS.Timeout | null = null;

  async function tick(): Promise<{ synced: number; failed: number }> {
    try {
      // Discover all active LinkedIn connections grouped by company
      const connections = await db
        .select()
        .from(composioConnections)
        .where(eq(composioConnections.appName, "linkedin"))
        .where(eq(composioConnections.status, "active"));

      // Deduplicate by companyId (one company may have multiple connections)
      const uniqueCompanies = new Set(connections.map((c) => c.companyId));
      const companies = Array.from(uniqueCompanies);

      logger.info(
        { companyCount: companies.length },
        "linkedin-sync-cron: discovered companies with active LinkedIn connections",
      );

      // Process up to MAX_CONCURRENT companies in parallel
      let synced = 0;
      let failed = 0;

      for (let i = 0; i < companies.length; i += MAX_CONCURRENT) {
        const batch = companies.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.allSettled(
          batch.map((companyId) =>
            linkedinIngestService({ companyId, db }).then((result) => {
              synced += result.postsProcessed + result.followersProcessed;
            }),
          ),
        );

        for (const result of results) {
          if (result.status === "rejected") {
            failed++;
            logger.error(
              { err: result.reason },
              "linkedin-sync-cron: company sync failed",
            );
          }
        }
      }

      logger.info({ synced, failed }, "linkedin-sync-cron: tick completed");
      return { synced, failed };
    } catch (err) {
      logger.error({ err }, "linkedin-sync-cron: tick error");
      return { synced: 0, failed: 1 };
    }
  }

  return {
    start() {
      if (intervalHandle) {
        logger.warn("linkedin-sync-cron: already started");
        return;
      }
      logger.info("linkedin-sync-cron: starting with 1h interval");
      intervalHandle = setInterval(() => {
        void tick().catch((err) => {
          logger.error({ err }, "linkedin-sync-cron: unhandled tick error");
        });
      }, DEFAULT_SYNC_INTERVAL_MS);
      // Unref so the interval doesn't keep the process alive
      intervalHandle?.unref?.();
      // Run once at startup
      void tick();
    },
    stop() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        logger.info("linkedin-sync-cron: stopped");
      }
    },
    tick,
  };
}
