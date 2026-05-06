/**
 * workflow-rate-limit.ts — S4.8 prerequisite #199.
 *
 * Per-tenant daily cap on customer-facing workflow_run creation. Council
 * 2026-05-06 finding #4 P1 BLOCK #8: "flawed kpi_anomaly query could flag
 * 5000 users → 5000 LLM calls + one-click 'Approve All' nukes domain
 * reputation. Need hard daily rate limit (suggested 50 runs/day per tenant)
 * for churn-rescue generation and deploy."
 *
 * ## Why no new table
 *
 * workflow_runs already records every run with companyId + template + createdAt.
 * A 24h rolling window count IS the rate counter — adding a separate
 * `workflow_rate_counters` table would be eventually-consistent with workflow_runs
 * and create read-your-write bugs. Counting from the source of truth is
 * cheap (indexed on (companyId, template, createdAt) is added below).
 *
 * ## Caps per template
 *
 * Defaults below are conservative starting points. Tunable via env override
 * `FOUNDEROS_WORKFLOW_DAILY_CAP_<TEMPLATE>` (e.g. FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE=100).
 * Unknown templates default to 50/day — fail-safe rather than fail-open.
 *
 * ## Rolling vs calendar
 *
 * Window is rolling 24h (now() - 24h) NOT calendar day. Calendar-day windows
 * have a noon-UTC reset surge that's measurable on every customer-facing
 * service that uses them — rolling spreads load + makes bursting predictable.
 *
 * ## Where to call
 *
 * From the workflow trigger / router BEFORE createWorkflowRun(). The function
 * throws RateLimitExceededError on cap; callers catch and return 429 to HTTP
 * paths or schedule the run for later via a defer-queue (deferred to phase 2).
 */

import { and, eq, gte, count, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { workflowRuns, type WorkflowTemplate } from "@founderos/db";
import { logger } from "../middleware/logger.js";

/**
 * Default daily caps per template. Override via env vars.
 *
 * Rationale (council 2026-05-06):
 *   - churn_rescue: 50/day. Highest-blast radius — autonomous LLM generation
 *     + email send + Stripe coupon. Domain reputation lives or dies here.
 *   - onboarding-emails: 200/day. Higher because triggered by sign-ups (a
 *     viral product could legitimately send 200+ welcome sequences in a day).
 *     Sign-up volume that exceeds 200 should be flagged as anomalous.
 *   - activation-nudge: 200/day. Same volume profile as onboarding.
 *   - upsell: 100/day. Highly-engaged free users; smaller cohort than signups.
 *   - product_update: 500/day. Marketing broadcast cadence; raise as needed.
 *   - default: 50/day. Fail-safe for new templates added without a cap entry.
 */
const DEFAULT_CAPS: Record<string, number> = {
  // Template names match the DB CHECK constraint at workflows_template_check
  // (migration 0087) — hyphenated, NOT underscored. Spec doc used underscore;
  // schema is the source of truth.
  "churn-rescue": 50,
  "onboarding-emails": 200,
  "activation-nudge": 200,
  upsell: 100,
  "product-update": 500,
};
const FALLBACK_CAP = 50;

/**
 * Compute the daily cap for a given template, applying env overrides.
 *
 * Env override format: FOUNDEROS_WORKFLOW_DAILY_CAP_<UPPER_SNAKE_TEMPLATE>.
 * Example: churn_rescue → FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE.
 * activation-nudge → FOUNDEROS_WORKFLOW_DAILY_CAP_ACTIVATION_NUDGE.
 */
export function getDailyCapForTemplate(template: string): number {
  const envKey =
    "FOUNDEROS_WORKFLOW_DAILY_CAP_" +
    template.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envVal = process.env[envKey];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    logger.warn(
      { envKey, envVal },
      "workflow-rate-limit: env override is not a positive int — falling back",
    );
  }
  return DEFAULT_CAPS[template] ?? FALLBACK_CAP;
}

export interface RateLimitDecision {
  allowed: boolean;
  template: string;
  companyId: string;
  cap: number;
  /** Number of runs created in the last 24h for this (company, template). */
  current: number;
  /** Reset window — when the oldest counted run will fall out of the window. */
  windowResetsAt: Date;
}

/**
 * checkWorkflowRunRateLimit — non-throwing rate check; returns the decision.
 *
 * Use this when the caller wants to handle the cap gracefully (defer-queue,
 * skip with note, etc). For HTTP-route callers preferring 429 short-circuit,
 * use `assertWorkflowRunRateLimit` instead.
 */
export async function checkWorkflowRunRateLimit(
  db: Db,
  companyId: string,
  template: WorkflowTemplate | string,
): Promise<RateLimitDecision> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cap = getDailyCapForTemplate(template);

  const [row] = await db
    .select({ c: count() })
    .from(workflowRuns)
    .innerJoin(
      sql`workflows`,
      sql`workflows.id = ${workflowRuns.workflowId}`,
    )
    .where(
      and(
        eq(workflowRuns.companyId, companyId),
        sql`workflows.template = ${template}`,
        gte(workflowRuns.createdAt, windowStart),
      ),
    );

  const current = Number(row?.c ?? 0);
  return {
    allowed: current < cap,
    template,
    companyId,
    cap,
    current,
    windowResetsAt: windowStart,
  };
}

export class RateLimitExceededError extends Error {
  constructor(
    public readonly decision: RateLimitDecision,
  ) {
    super(
      `workflow-rate-limit: ${decision.template} for company ${decision.companyId} ` +
        `exceeded daily cap (${decision.current}/${decision.cap}); window resets after ${decision.windowResetsAt.toISOString()}`,
    );
    this.name = "RateLimitExceededError";
  }
}

/**
 * assertWorkflowRunRateLimit — throwing rate check.
 *
 * Throws RateLimitExceededError if the cap is hit. Callers in HTTP routes
 * catch this and return 429.
 */
export async function assertWorkflowRunRateLimit(
  db: Db,
  companyId: string,
  template: WorkflowTemplate | string,
): Promise<RateLimitDecision> {
  const decision = await checkWorkflowRunRateLimit(db, companyId, template);
  if (!decision.allowed) {
    logger.warn(
      {
        companyId: decision.companyId,
        template: decision.template,
        current: decision.current,
        cap: decision.cap,
      },
      "workflow-rate-limit: cap exceeded — blocking run creation",
    );
    throw new RateLimitExceededError(decision);
  }
  return decision;
}
