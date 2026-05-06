/**
 * Cron-tick wrapper — composes `runInCronContext` with try/catch + Sentry
 * capture + structured duration logging.
 *
 * Council 2026-05-07 P1-5 — pre-fix, 7 of 8 business cron schedulers
 * (daily-digest, linkedin-sync, slack-sync, hubspot-sync, weekly-wrap,
 * notion-sync, decision-followup) bypassed `runInCronContext`, so logs
 * emitted from inside the tick body had empty `requestId`/`traceId`/`actor`
 * tags (the pino mixin returns `{}` outside any active context). And
 * ZERO cron files called `captureServerError`, so the only failure
 * signal was a stderr log line — invisible to Sentry, invisible to
 * any oncall dashboard.
 *
 * `runCronTick(taskName, fn)`:
 *   - Wraps `fn` in `runInCronContext(taskName, ...)` — pino logs and
 *     Sentry events emitted from inside `fn` carry a deterministic
 *     `cron:<taskName>:<uuid>` requestId and `actor: { type: "system" }`.
 *   - try/catch around the await — uncaught throws (network, DB,
 *     downstream service) become structured `error` logs + a Sentry
 *     event tagged with `taskName` and the elapsed duration.
 *   - Returns `undefined` on failure rather than re-throwing — the
 *     setInterval site in cron `start()` does not want an unhandled
 *     promise rejection. The next tick proceeds normally.
 *
 * Pattern at the call site:
 *
 *   timer = setInterval(() => {
 *     void runCronTick("daily-digest", tick);
 *   }, tickIntervalMs);
 *
 * Tests: `__tests__/cron-tick.test.ts` covers context propagation,
 * error capture, return shape, and duration measurement.
 */

import { runInCronContext, getRequestContext } from "./request-context.js";
import { logger } from "../middleware/logger.js";
import { captureServerError } from "../observability/sentry.js";

export async function runCronTick<T>(
  taskName: string,
  fn: () => Promise<T> | T,
): Promise<T | undefined> {
  return runInCronContext(taskName, async () => {
    const start = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - start;
      // Debug-level success log — production deployments typically run at
      // info; this avoids noise per-tick while still being inspectable
      // when LOG_LEVEL=debug. The duration is the load-bearing field.
      logger.debug(
        { taskName, durationMs },
        `cron:${taskName} ok`,
      );
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      // Structured error log — pulls active request context (set by
      // runInCronContext above) into the pino mixin: requestId, traceId,
      // actor tags. Same fields appear on the Sentry event below.
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          taskName,
          durationMs,
        },
        `cron:${taskName} threw`,
      );
      // Sentry capture is a no-op when SENTRY_DSN is unset (see
      // observability/sentry.ts). The active request context (cron
      // requestId/traceId/actor) auto-attaches via the scope enricher
      // in initServerSentry — no extra wiring needed here.
      captureServerError(err, { taskName, durationMs });
      return undefined;
    }
  });
}

/**
 * Test helper — exported so tests can read the active context from
 * inside a `runCronTick(...)` callback without re-importing
 * request-context.
 */
export { getRequestContext };

/**
 * BullMQ-shape sibling of `runCronTick`. Same composition (cron context,
 * structured duration log, Sentry capture) — but RE-THROWS after capture
 * instead of swallowing.
 *
 * Council 2026-05-07 P1-5b — `hubspot-sync-cron.ts` is the 7th business
 * cron and is shaped as a BullMQ recurring job + Worker callback, not a
 * `setInterval`. BullMQ's contract is the inverse of setInterval's:
 *
 *   - setInterval cron: error must be SWALLOWED. The next tick proceeds
 *     normally; an unhandled rejection from `void runCronTick(...)` would
 *     crash the process under Node 24's default unhandledRejection
 *     behavior. → use `runCronTick`.
 *
 *   - BullMQ cron: error must be RE-THROWN. The Worker's `failed` event
 *     fires only when the job callback throws; the queue's retry / DLQ
 *     machinery depends on the throw to mark the job failed. Swallowing
 *     would silently mark every failed job as succeeded. → use this.
 *
 * Pattern at the call site (BullMQ Worker):
 *
 *   const worker = new Worker(QUEUE, async (job) => {
 *     return runCronTaskWithRethrow(
 *       "hubspot-sync",
 *       () => syncAllWorkspaces(db),
 *       { jobId: job.id, jobName: job.name },
 *     );
 *   }, ...);
 *
 * Optional `extraContext` is merged into both the structured error log
 * and the Sentry capture context — useful for BullMQ to attach jobId /
 * jobName so the Sentry event correlates back to the queue row.
 */
export async function runCronTaskWithRethrow<T>(
  taskName: string,
  fn: () => Promise<T> | T,
  extraContext?: Record<string, unknown>,
): Promise<T> {
  return runInCronContext(taskName, async () => {
    const start = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - start;
      logger.debug(
        { taskName, durationMs, ...extraContext },
        `cron:${taskName} ok`,
      );
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          taskName,
          durationMs,
          ...extraContext,
        },
        `cron:${taskName} threw`,
      );
      // Capture FIRST, while the cron request context is still active —
      // Sentry's scope enricher reads getRequestContext() at this exact
      // call. Then re-throw so BullMQ's failed handler (and retry/DLQ
      // policy) can react.
      captureServerError(err, { taskName, durationMs, ...extraContext });
      throw err;
    }
  });
}
