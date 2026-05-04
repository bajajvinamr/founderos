/**
 * BYO-103 — `byo_runner` adapter (ADR-011).
 *
 * Cloud-side adapter whose execute() does NOT spawn anything locally.
 * Instead it materializes a `runner_jobs` row from the heartbeat input,
 * then polls until the row reaches a terminal state (completed/failed/
 * cancelled). The actual claude execution happens on the user's laptop
 * via `@founderos/runner` (BYO-201..208).
 *
 * Why polling and not LISTEN/NOTIFY for v0:
 *   - PG LISTEN/NOTIFY is server-singleton-friendly but adds connection
 *     state we don't need at v0 scale.
 *   - 1s tick polling keeps the server-side logic completely stateless.
 *   - We can graduate to NOTIFY in v2 if active-run count exceeds ~50.
 *
 * Concurrency: the heartbeat scheduler already throttles concurrent runs
 * via its existing claim/queue logic. This adapter inherits that. Each
 * call to execute() holds exactly one promise per active run.
 *
 * Skill sync gap (declared in ADR-011):
 *   `byo_runner` deliberately does NOT implement listSkills / syncSkills.
 *   v0 expects the user to manage skills locally with `claude install-skill`.
 *   Cloud-driven skill manifest sync is a v2 task tracked in CLAUDE.md
 *   Phase 1 backlog.
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  ServerAdapterModule,
} from "@founderos/adapter-utils";
import { renderTemplate } from "@founderos/adapter-utils/server-utils";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { runnerJobs } from "@founderos/db";
import { logger } from "../../middleware/logger.js";
import { isByoRunnerEnabled } from "../../lib/byo-runner-flag.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** How often to poll runner_jobs.status while waiting for the runner. */
const POLL_INTERVAL_MS = 1_000;

/** Hard upper bound on how long execute() can wait. Per-run timeoutSec
 *  from runtimeConfig overrides this when smaller. */
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1_000;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── execute ────────────────────────────────────────────────────────────────

/**
 * Build the byo_runner adapter against a specific db handle. The factory
 * shape (rather than a free-standing object) lets tests inject an
 * embedded-PG client without touching globals.
 */
export function createByoRunnerAdapter(db: Db): ServerAdapterModule {
  return {
    type: "byo_runner",

    async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
      // Belt-and-suspenders: refuse to enqueue if the flag is off, even if
      // the adapter was somehow registered. This pairs with the registry
      // gate in registry.ts.
      if (!isByoRunnerEnabled()) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "byo_runner_disabled",
          errorMessage:
            "byo_runner adapter invoked while FOUNDEROS_BYO_RUNNER_ENABLED is unset",
        };
      }

      const { runId, agent, runtime, config, context, onLog } = ctx;

      // ─── Build prompt (matches claude-local's basic shape) ──────────────
      // v0 keeps this simple: render the configured promptTemplate against
      // the heartbeat context. Resume logic + skill bundles + bootstrap
      // prompts are deferred to v2 — the runner-side claude will pick up
      // session continuity via --resume on the runner machine.
      const promptTemplate = asString(
        config.promptTemplate,
        "You are agent {{agent.id}} ({{agent.name}}). Continue your FounderOS work.",
      );
      const templateData = {
        agentId: agent.id,
        companyId: agent.companyId,
        runId,
        agent,
        run: { id: runId, source: "on_demand" },
        context,
      };
      const prompt = renderTemplate(promptTemplate, templateData);
      const promptHash = sha256Hex(prompt);

      // ─── Runtime config snapshot for the runner ─────────────────────────
      const timeoutSec = asNumber(config.timeoutSec, 600);
      const runtimeConfigJson = JSON.stringify({
        model: asString(config.model, ""),
        maxTurns: asNumber(config.maxTurnsPerRun, 0),
        timeoutSec,
        // v0 doesn't ship instructions or addDirs over the wire — runner
        // configures these locally based on the user's environment.
      });

      // ─── Enqueue runner_jobs row ────────────────────────────────────────
      let jobId: string;
      try {
        const [row] = await db
          .insert(runnerJobs)
          .values({
            companyId: agent.companyId,
            agentId: agent.id,
            heartbeatRunId: runId,
            prompt,
            promptHash,
            sessionIdHint: asString(runtime.sessionId, "") || null,
            runtimeConfig: runtimeConfigJson,
            status: "queued",
          })
          .returning({ id: runnerJobs.id });
        jobId = row.id;
      } catch (err) {
        logger.error(
          { err, runId, agentId: agent.id, companyId: agent.companyId },
          "byo_runner.execute: failed to enqueue runner_jobs row",
        );
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "runner_enqueue_failed",
          errorMessage: err instanceof Error ? err.message : "enqueue failed",
        };
      }

      await onLog(
        "stdout",
        `[founderos] queued runner job ${jobId} for agent ${agent.name} — waiting for local runner.\n`,
      );

      // ─── Wait for terminal ──────────────────────────────────────────────
      const maxWaitMs = Math.min(timeoutSec * 1_000, DEFAULT_MAX_WAIT_MS);
      const startedAt = Date.now();
      let lastStatus = "queued";
      while (Date.now() - startedAt < maxWaitMs) {
        await sleep(POLL_INTERVAL_MS);

        const [row] = await db
          .select({
            status: runnerJobs.status,
            exitCode: runnerJobs.exitCode,
            signal: runnerJobs.signal,
            elapsedMs: runnerJobs.elapsedMs,
            costMicros: runnerJobs.costMicros,
            sessionIdAfter: runnerJobs.sessionIdAfter,
            cliVersion: runnerJobs.cliVersion,
            errorMessage: runnerJobs.errorMessage,
          })
          .from(runnerJobs)
          .where(eq(runnerJobs.id, jobId))
          .limit(1);

        if (!row) {
          // Row vanished — should be impossible given cascade rules, but
          // surface as an error rather than spinning forever.
          return {
            exitCode: null,
            signal: null,
            timedOut: false,
            errorCode: "runner_job_missing",
            errorMessage: `runner_jobs row ${jobId} disappeared mid-wait`,
          };
        }

        if (row.status !== lastStatus) {
          await onLog(
            "stdout",
            `[founderos] runner job ${jobId}: ${lastStatus} → ${row.status}\n`,
          );
          lastStatus = row.status;
        }

        if (TERMINAL_STATUSES.has(row.status)) {
          const costUsd =
            row.costMicros != null ? row.costMicros / 1_000_000 : null;
          return {
            exitCode: row.exitCode ?? null,
            signal: row.signal ?? null,
            timedOut: false,
            errorMessage: row.errorMessage ?? undefined,
            errorCode: row.status === "failed" ? "runner_failed" : undefined,
            sessionId: row.sessionIdAfter ?? null,
            costUsd,
            resultJson: {
              runnerJobId: jobId,
              cliVersion: row.cliVersion ?? null,
              elapsedMs: row.elapsedMs ?? null,
              terminalStatus: row.status,
            },
          };
        }
      }

      // ─── Timeout ────────────────────────────────────────────────────────
      // Mark the row failed so a re-poll from the runner gets a clear 409
      // and we don't accumulate orphaned rows.
      try {
        await db
          .update(runnerJobs)
          .set({
            status: "failed",
            completedAt: new Date(),
            errorMessage: `cloud-side wait timed out after ${maxWaitMs}ms`,
          })
          .where(eq(runnerJobs.id, jobId));
      } catch (err) {
        logger.warn(
          { err, jobId },
          "byo_runner.execute: timeout cleanup update failed (non-fatal)",
        );
      }

      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorCode: "runner_timeout",
        errorMessage: `Local runner did not complete job ${jobId} within ${maxWaitMs}ms. Is the runner running?`,
      };
    },

    async testEnvironment(_ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
      // v0 environment test is a stub — the real environment lives on the
      // user's machine inside their @founderos/runner process. We surface
      // a single info-level check pointing them at the install card.
      return {
        adapterType: "byo_runner",
        status: "pass",
        testedAt: new Date().toISOString(),
        checks: [
          {
            code: "byo_runner.runtime_is_local",
            level: "info",
            message: "byo_runner agents execute on your local machine via @founderos/runner.",
            hint:
              "Install: `npx @founderos/runner --token=<your-token>`. " +
              "Verify the dashboard shows a green liveness dot for your token.",
          },
        ],
      };
    },
  };
}
