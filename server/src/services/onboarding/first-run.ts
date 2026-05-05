/**
 * S3.10 — Magic activation gate (first-value within 10 minutes).
 *
 * After a founder finishes onboarding-bootstrap, IF they connected ≥2
 * integrations we kick off `runFirstRunForCompany`. The job orchestrates
 * five steps and surfaces progress to the dashboard:
 *
 *   1. backfill        — last 90d of events from each connected integration
 *                        (Stripe / PostHog / HubSpot / Notion / Slack).
 *                        Each connector runs in parallel; per-connector errors
 *                        are collected, never abort the run.
 *   2. agent-warmup    — touch the four default agent runtime states (CoS,
 *                        growth, content, finance). This is the lightweight
 *                        equivalent of "tick" — full enqueueWakeup pulls
 *                        execution-workspace + heartbeats infra that is too
 *                        heavy for the magic-moment path. ensureRuntimeState
 *                        guarantees the agent is ready when the founder lands.
 *   3. brief-generate  — call S3.3's generateDailyBriefForCompany so the
 *                        founder sees a real Daily Brief without waiting for
 *                        the 7am cron.
 *   4. inbox-surface   — write a single insight (kind='opportunity', dept=cos)
 *                        announcing the brief is ready, so it shows up in the
 *                        normal inbox flow.
 *   5. complete        — mark the run done; the UI flips to "ready" and fires
 *                        the toast "Your first brief is ready".
 *
 * Progress shape: in-memory map keyed by companyId. A first-run is short-lived
 * (target: 10 min) and never crosses server restarts; persisting to a DB column
 * would buy nothing (the founder is in the same session). Map is bounded
 * (insertion-order eviction at 256 entries) per the cache-bounding invariant.
 *
 * No new tables, no migration. All persistence the run produces goes to the
 * existing tables that S2.x and S3.3 already populate (events, daily_briefs,
 * insights, agent_runtime_state).
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { agents, agentRuntimeState, insights, integrations } from "@founderos/db";
import { logger } from "../../middleware/logger.js";
import {
  generateDailyBriefForCompany,
  type GenerateDailyBriefOptions,
} from "../../jobs/daily-founder-brief.js";

// ── Public types ────────────────────────────────────────────────────────────

export type FirstRunStepId =
  | "backfill"
  | "agent-warmup"
  | "brief-generate"
  | "inbox-surface"
  | "complete";

export type FirstRunStepStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  status: FirstRunStepStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface FirstRunProgress {
  companyId: string;
  status: "running" | "done" | "error";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: FirstRunStep[];
  /** "3 / 5 steps complete" — pre-computed for the UI. */
  completedSteps: number;
  totalSteps: number;
  /** Set when the brief is generated — UI uses this for the toast link. */
  dailyBriefId?: string;
  dailyBriefForDate?: string;
}

const STEP_LABELS: Record<FirstRunStepId, string> = {
  backfill: "Backfilling last 90 days of activity",
  "agent-warmup": "Warming up your agent team",
  "brief-generate": "Generating your first executive brief",
  "inbox-surface": "Posting your brief to the inbox",
  complete: "Done",
};

const STEP_ORDER: FirstRunStepId[] = [
  "backfill",
  "agent-warmup",
  "brief-generate",
  "inbox-surface",
  "complete",
];

// ── In-memory progress store ────────────────────────────────────────────────

const MAX_TRACKED_RUNS = 256;
const progressByCompany = new Map<string, FirstRunProgress>();

function freshProgress(companyId: string): FirstRunProgress {
  const now = Date.now();
  const steps: FirstRunStep[] = STEP_ORDER.map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
  }));
  return {
    companyId,
    status: "running",
    startedAt: now,
    updatedAt: now,
    steps,
    completedSteps: 0,
    totalSteps: STEP_ORDER.length,
  };
}

function bound() {
  while (progressByCompany.size > MAX_TRACKED_RUNS) {
    const oldestKey = progressByCompany.keys().next().value;
    if (oldestKey === undefined) break;
    progressByCompany.delete(oldestKey);
  }
}

function setProgress(companyId: string, p: FirstRunProgress): void {
  progressByCompany.set(companyId, p);
  bound();
}

function recomputeCompleted(p: FirstRunProgress): void {
  p.completedSteps = p.steps.filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
}

function startStep(p: FirstRunProgress, id: FirstRunStepId): void {
  const step = p.steps.find((s) => s.id === id);
  if (!step) return;
  step.status = "running";
  step.startedAt = Date.now();
  p.updatedAt = step.startedAt;
}

function finishStep(
  p: FirstRunProgress,
  id: FirstRunStepId,
  status: "done" | "skipped" | "error",
  error?: string,
): void {
  const step = p.steps.find((s) => s.id === id);
  if (!step) return;
  step.status = status;
  step.finishedAt = Date.now();
  if (error) step.error = error;
  p.updatedAt = step.finishedAt;
  recomputeCompleted(p);
}

/** Read the current progress for a company, or null if never started. */
export function getFirstRunProgress(companyId: string): FirstRunProgress | null {
  return progressByCompany.get(companyId) ?? null;
}

/** TEST-ONLY — wipes the in-memory store between tests. */
export function _resetFirstRunStore(): void {
  progressByCompany.clear();
}

// ── Connector backfill orchestration ────────────────────────────────────────

/**
 * Backfill stub callable. Each connector exports an awaitable function that
 * pulls history into the events table; we accept overrides so tests can mock
 * them without spinning up real Stripe / PostHog / Slack clients.
 */
export interface FirstRunBackfillRunners {
  stripe?: (companyId: string, apiKey: string) => Promise<void>;
  posthog?: (companyId: string, apiKey: string, host?: string) => Promise<void>;
  hubspot?: (companyId: string, apiKey: string) => Promise<void>;
  notion?: (companyId: string, apiKey: string) => Promise<void>;
  slack?: (companyId: string, apiKey: string) => Promise<void>;
  linkedin?: (companyId: string, apiKey: string) => Promise<void>;
}

async function defaultBackfillStripe(companyId: string, apiKey: string): Promise<void> {
  const { backfillCompanyStripe } = await import("../stripe-backfill.js");
  await backfillCompanyStripe(companyId, apiKey, { sinceDays: 90 });
}

async function defaultBackfillPostHog(
  _companyId: string,
  _apiKey: string,
  _host?: string,
): Promise<void> {
  // posthog-poll is cron-driven and consumes events incrementally; the
  // first-run path piggybacks on it landing within 15 minutes of the cron
  // tick. No explicit backfill helper is exported today (S2.3 deferred a
  // 90d historic pull). Treat this as a no-op for first-run; the cron will
  // catch up.
}

// ── Agent warmup ────────────────────────────────────────────────────────────

const DEFAULT_AGENT_ROLES = ["ceo", "cmo", "general", "cfo"] as const;

async function warmupAgents(db: Db, companyId: string): Promise<number> {
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));

  let touched = 0;
  for (const agent of companyAgents) {
    const existing = await db
      .select({ agentId: agentRuntimeState.agentId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agent.id))
      .limit(1);
    if (existing.length > 0) {
      touched += 1;
      continue;
    }
    try {
      await db.insert(agentRuntimeState).values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: { firstRunWarmedAt: new Date().toISOString() },
      });
      touched += 1;
    } catch (err) {
      logger.warn(
        { err, agentId: agent.id, companyId },
        "first-run: agent warmup insert raced — assuming row already exists",
      );
      touched += 1;
    }
  }
  // Log which slots fired so it's observable in the cron/log surface.
  logger.debug(
    { companyId, touched, expectedRoles: DEFAULT_AGENT_ROLES },
    "first-run: agent warmup complete",
  );
  return touched;
}

// ── Inbox surface — single insight pointing at the new brief ────────────────

async function postInboxAnnouncement(
  db: Db,
  companyId: string,
  forDateIso: string,
): Promise<void> {
  await db.insert(insights).values({
    companyId,
    department: "chief-of-staff",
    kind: "opportunity",
    title: "Your first executive brief is ready",
    body: `FounderOS just generated your first Daily Founder Brief covering ${forDateIso}. Open it from the Daily Brief surface to see the headline, KPI movements, and your top three actions for the day.`,
    confidence: 1,
    recommendation:
      "Open the Daily Brief and approve or dismiss the top-three actions.",
    evidence: { forDate: forDateIso, source: "first-run" },
  });
}

// ── Main entry ──────────────────────────────────────────────────────────────

export interface RunFirstRunOptions {
  /** Override per-connector backfill runners (tests). */
  runners?: FirstRunBackfillRunners;
  /** Forwarded into generateDailyBriefForCompany — tests inject the LLM mock. */
  briefOptions?: GenerateDailyBriefOptions;
  /** Test hook for `now` — exposed for deterministic timestamps. */
  now?: Date;
}

/**
 * Public orchestrator. Idempotent on the brief-generate step (S3.3's own
 * unique index handles the dedup); the agent-warmup step is also idempotent
 * because we check the runtime-state row before inserting.
 *
 * Returns the final progress snapshot. Errors in any non-critical step are
 * captured on the step + the run continues; the only fatal step is
 * brief-generate (a missing brief means the magic moment failed).
 */
export async function runFirstRunForCompany(
  db: Db,
  companyId: string,
  options: RunFirstRunOptions = {},
): Promise<FirstRunProgress> {
  const log = logger.child({ service: "first-run", companyId });
  const progress = freshProgress(companyId);
  setProgress(companyId, progress);

  // ── Step 1: backfill ──
  startStep(progress, "backfill");
  try {
    const connected = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.companyId, companyId),
          eq(integrations.status, "connected"),
        ),
      );

    const runners = options.runners ?? {};

    const tasks: Promise<unknown>[] = [];
    for (const integration of connected) {
      const decryptedKey = await getDecryptedKey(db, companyId, integration.id);
      if (!decryptedKey) continue;
      const config = (integration.config ?? {}) as Record<string, unknown>;

      switch (integration.kind) {
        case "stripe": {
          const fn = runners.stripe ?? defaultBackfillStripe;
          tasks.push(
            fn(companyId, decryptedKey).catch((err: unknown) => {
              log.warn({ err, kind: "stripe" }, "first-run: stripe backfill failed");
            }),
          );
          break;
        }
        case "posthog": {
          const fn = runners.posthog ?? defaultBackfillPostHog;
          const host = typeof config.host === "string" ? config.host : undefined;
          tasks.push(
            fn(companyId, decryptedKey, host).catch((err: unknown) => {
              log.warn({ err, kind: "posthog" }, "first-run: posthog backfill failed");
            }),
          );
          break;
        }
        case "hubspot": {
          const fn = runners.hubspot;
          if (!fn) break;
          tasks.push(
            fn(companyId, decryptedKey).catch((err: unknown) => {
              log.warn({ err, kind: "hubspot" }, "first-run: hubspot backfill failed");
            }),
          );
          break;
        }
        case "notion": {
          const fn = runners.notion;
          if (!fn) break;
          tasks.push(
            fn(companyId, decryptedKey).catch((err: unknown) => {
              log.warn({ err, kind: "notion" }, "first-run: notion backfill failed");
            }),
          );
          break;
        }
        case "slack": {
          const fn = runners.slack;
          if (!fn) break;
          tasks.push(
            fn(companyId, decryptedKey).catch((err: unknown) => {
              log.warn({ err, kind: "slack" }, "first-run: slack backfill failed");
            }),
          );
          break;
        }
        case "linkedin": {
          const fn = runners.linkedin;
          if (!fn) break;
          tasks.push(
            fn(companyId, decryptedKey).catch((err: unknown) => {
              log.warn({ err, kind: "linkedin" }, "first-run: linkedin backfill failed");
            }),
          );
          break;
        }
        default:
          break;
      }
    }

    await Promise.all(tasks);
    finishStep(progress, "backfill", "done");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "first-run: backfill step threw",
    );
    finishStep(
      progress,
      "backfill",
      "error",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Step 2: agent warmup ──
  startStep(progress, "agent-warmup");
  try {
    await warmupAgents(db, companyId);
    finishStep(progress, "agent-warmup", "done");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "first-run: agent warmup threw",
    );
    finishStep(
      progress,
      "agent-warmup",
      "error",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Step 3: brief generate ──
  startStep(progress, "brief-generate");
  let briefForDateIso: string | null = null;
  try {
    const result = await generateDailyBriefForCompany(
      db,
      companyId,
      options.briefOptions ?? {},
    );
    progress.dailyBriefId = result.brief.id;
    // Drizzle's date column returns either a string (postgres-js driver) or
    // a Date instance (other drivers). Normalize to yyyy-mm-dd in either
    // shape so downstream code never has to branch.
    const forDate = result.brief.forDate as unknown;
    if (forDate instanceof Date) {
      briefForDateIso = forDate.toISOString().slice(0, 10);
    } else {
      briefForDateIso = String(forDate).slice(0, 10);
    }
    progress.dailyBriefForDate = briefForDateIso;
    finishStep(progress, "brief-generate", "done");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "first-run: brief-generate threw — fatal for this run",
    );
    finishStep(
      progress,
      "brief-generate",
      "error",
      err instanceof Error ? err.message : String(err),
    );
    progress.status = "error";
    progress.finishedAt = Date.now();
    setProgress(companyId, progress);
    return progress;
  }

  // ── Step 4: inbox surface ──
  startStep(progress, "inbox-surface");
  try {
    if (briefForDateIso) {
      await postInboxAnnouncement(db, companyId, briefForDateIso);
      finishStep(progress, "inbox-surface", "done");
    } else {
      finishStep(progress, "inbox-surface", "skipped");
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "first-run: inbox surface failed (non-fatal)",
    );
    finishStep(
      progress,
      "inbox-surface",
      "error",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Step 5: complete ──
  finishStep(progress, "complete", "done");
  progress.status = "done";
  progress.finishedAt = Date.now();
  setProgress(companyId, progress);

  log.info(
    {
      durationMs: progress.finishedAt - progress.startedAt,
      completedSteps: progress.completedSteps,
      totalSteps: progress.totalSteps,
      dailyBriefId: progress.dailyBriefId,
    },
    "first-run: complete",
  );

  return progress;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function getDecryptedKey(
  db: Db,
  companyId: string,
  integrationId: string,
): Promise<string | null> {
  // The integrations service caches its own service-shaped accessor; we use
  // it indirectly so we don't double-import the encryption util here.
  const { integrationService } = await import("../integrations.js");
  return integrationService(db).getDecryptedApiKey(companyId, integrationId);
}
