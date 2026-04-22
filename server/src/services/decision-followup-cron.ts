/**
 * Decision Follow-up Cron.
 *
 * Every 6 hours, scans for approved approvals older than DEFAULT_FOLLOWUP_DELAY_MS
 * (14 days) that have no decision_outcomes row and inserts a `pending_followup`
 * row for each. This is what drives the "what happened?" prompt the founder
 * sees two weeks after approving a decision.
 *
 * Design notes:
 *   - setInterval-based, unref'd so it never blocks process shutdown.
 *   - Idempotent: the underlying service does a NOT EXISTS check against
 *     decision_outcomes, so double-running the tick (or overlapping ticks)
 *     never creates duplicate prompts for the same approval.
 *   - Errors are logged and swallowed — a single bad tick never kills the
 *     timer; the next tick will retry.
 */

import type { Db } from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { decisionOutcomeService } from "./decision-outcomes.js";

/** Cron tick cadence: every 6 hours. */
export const DEFAULT_TICK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/** Follow up 14 days after the approval was decided. */
export const DEFAULT_FOLLOWUP_DELAY_MS = 14 * 24 * 60 * 60 * 1_000;

export interface DecisionFollowupCronOptions {
  db: Db;
  /** Override tick cadence in ms. Defaults to 6h. */
  tickIntervalMs?: number;
  /** Override follow-up window in ms. Defaults to 14 days. */
  followupDelayMs?: number;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface DecisionFollowupCron {
  /** Start the interval. Also fires one immediate tick. */
  start: () => void;
  /** Stop the interval. Safe to call more than once. */
  stop: () => void;
  /** Run a single tick synchronously — useful for tests and manual triggers. */
  runOnce: () => Promise<{ created: number }>;
}

export function createDecisionFollowupCron(
  opts: DecisionFollowupCronOptions,
): DecisionFollowupCron {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const followupDelayMs = opts.followupDelayMs ?? DEFAULT_FOLLOWUP_DELAY_MS;
  const now = opts.now ?? (() => new Date());
  const svc = decisionOutcomeService(opts.db);

  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<{ created: number }> {
    const cutoff = new Date(now().getTime() - followupDelayMs);
    try {
      const result = await svc.createPromptsForOverdueApprovals(cutoff);
      if (result.created > 0) {
        logger.info(
          { createdOutcomes: result.created, cutoff: cutoff.toISOString() },
          "decision-followup-cron: created follow-up prompts",
        );
      }
      return { created: result.created };
    } catch (err) {
      logger.error(
        { err, cutoff: cutoff.toISOString() },
        "decision-followup-cron: tick failed",
      );
      return { created: 0 };
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
