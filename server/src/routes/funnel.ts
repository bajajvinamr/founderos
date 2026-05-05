/**
 * Funnel diagnostics route (S3.7).
 *
 *   GET /api/companies/:id/funnel
 *
 * Computes the standard 5-step pirate funnel from the canonical `events`
 * table over the last 30 days:
 *
 *   pageview     → Traffic
 *   identify     → Signup
 *   activated    → Activation
 *   retained_7d  → Retention
 *   subscribed   → Paid
 *
 * Aggregation: count distinct `payload->>'distinctId'` per step. Falls back
 * to `event_name` row count when distinctId is null/absent so an event source
 * that omits identity doesn't silently zero out the funnel.
 *
 * Drop-off: `dropFromPrev` = (prevCount - thisCount) / prevCount, expressed
 * as a 0..1 fraction. The first step has `dropFromPrev: null` (no prior).
 *
 * Worst step: the step with the largest `dropFromPrev`. Ties resolve to the
 * step that appears later in the funnel (closer to revenue is more painful).
 *
 * Insight emission: when worstStep.dropFromPrev > 0.5 AND no insight of
 * kind='blocker' with the same title was created in the last 24h, write an
 * `insights` row. The 24h dedup window prevents the funnel-poll cron from
 * creating duplicates across multiple page loads. Idempotency is best-effort
 * (no advisory lock) — under concurrent requests we may write 2 insights;
 * the UI tolerates duplicates and the dedup window keeps the steady-state
 * write rate low.
 *
 * Drizzle gotchas honoured:
 *   - JSONB path uses `sql\`payload->>'distinctId'\`` rather than .eq() —
 *     Drizzle has no first-class JSONB path operator.
 *   - .where() chain composes via and(...) once.
 *   - db.execute(sql\`...\`) takes a template literal, not (string, params).
 */

import { Router } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events, insights } from "@founderos/db";
import { assertCompanyAccess } from "./authz.js";

// ─── Funnel definition ───────────────────────────────────────────────────────

/**
 * Default funnel definition. Workspace-configurable later (S3.x); for now
 * the same 5 events are used for every company. Order is significant —
 * dropFromPrev is computed against the previous entry.
 */
const DEFAULT_FUNNEL = [
  { eventName: "pageview", displayName: "Traffic" },
  { eventName: "identify", displayName: "Signup" },
  { eventName: "activated", displayName: "Activation" },
  { eventName: "retained_7d", displayName: "Retention" },
  { eventName: "subscribed", displayName: "Paid" },
] as const;

const FUNNEL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WORST_STEP_THRESHOLD = 0.5; // emit blocker insight when drop > 50%
const INSIGHT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h dedup window

// ─── Types (response shape) ──────────────────────────────────────────────────

export interface FunnelStep {
  name: string;
  count: number;
  dropFromPrev: number | null;
}

export interface FunnelDiagnosticsResponse {
  steps: FunnelStep[];
  worstStep: string | null;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function funnelRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:id/funnel", async (req, res) => {
    const companyId = req.params.id as string;
    assertCompanyAccess(req, companyId);

    const since = new Date(Date.now() - FUNNEL_WINDOW_MS);

    // One query per step. Could be flattened into a single aggregate with a
    // FILTER per event_name, but the per-step query is simpler to reason
    // about and the index on (company_id, occurred_at DESC) keeps each scan
    // bounded to the 30d slice. For 5 steps this is cheap.
    const counts: number[] = [];
    for (const step of DEFAULT_FUNNEL) {
      // COUNT(DISTINCT payload->>'distinctId') — falls back to COUNT(*) when
      // distinctId is null. Sources that omit a distinctId would otherwise
      // collapse to a single bucket. COALESCE on the JSONB extraction means
      // a row with `null` distinctId still counts as a unique visitor for
      // the purposes of the funnel (best-effort signal vs zero-data).
      const result = await db
        .select({
          count: sql<string>`COUNT(DISTINCT COALESCE(${events.payload}->>'distinctId', ${events.id}::text))`,
        })
        .from(events)
        .where(
          and(
            eq(events.companyId, companyId),
            eq(events.eventName, step.eventName),
            gte(events.occurredAt, since),
          ),
        );

      // postgres-js returns COUNT as a string (bigint-safe).
      const raw = result[0]?.count ?? "0";
      counts.push(Number.parseInt(raw, 10) || 0);
    }

    const steps: FunnelStep[] = DEFAULT_FUNNEL.map((step, idx) => {
      const count = counts[idx];
      let dropFromPrev: number | null = null;
      if (idx > 0) {
        const prev = counts[idx - 1];
        if (prev > 0) {
          dropFromPrev = (prev - count) / prev;
        } else {
          // No upstream traffic — drop is undefined; surface as null rather
          // than a misleading 0 or 1. Front end renders "—".
          dropFromPrev = null;
        }
      }
      return {
        name: step.displayName,
        count,
        dropFromPrev,
      };
    });

    // Pick the worst step (largest dropFromPrev). Ties resolve to the LATER
    // step — losing a paying user is worse than losing a top-of-funnel visitor.
    let worstStepName: string | null = null;
    let worstDrop = -Infinity;
    for (const s of steps) {
      if (s.dropFromPrev !== null && s.dropFromPrev >= worstDrop) {
        worstDrop = s.dropFromPrev;
        worstStepName = s.name;
      }
    }

    const response: FunnelDiagnosticsResponse = {
      steps,
      worstStep: worstStepName,
    };

    // Emit a blocker insight when the worst drop crosses the threshold and
    // we haven't already emitted one for this funnel step in the dedup
    // window. Best-effort: we tolerate the rare race where two concurrent
    // requests both emit. The dedup window means steady-state write rate
    // stays at ~1 row per 24h per company per worst-step.
    if (
      worstStepName !== null &&
      Number.isFinite(worstDrop) &&
      worstDrop > WORST_STEP_THRESHOLD
    ) {
      const title = `Funnel drop-off at ${worstStepName}`;
      const dedupSince = new Date(Date.now() - INSIGHT_DEDUP_WINDOW_MS);

      const [existing] = await db
        .select({ id: insights.id })
        .from(insights)
        .where(
          and(
            eq(insights.companyId, companyId),
            eq(insights.kind, "blocker"),
            eq(insights.title, title),
            gte(insights.createdAt, dedupSince),
          ),
        )
        .orderBy(desc(insights.createdAt))
        .limit(1);

      if (!existing) {
        const dropPct = Math.round(worstDrop * 100);
        await db.insert(insights).values({
          companyId,
          department: "growth",
          kind: "blocker",
          title,
          body: `${dropPct}% of users drop between the previous step and ${worstStepName} over the last 30 days. This is the largest single-step loss in the funnel.`,
          confidence: 0.8,
          recommendation: `Investigate the transition into ${worstStepName}. Run a qualitative audit (session replays, exit intercept) and propose an experiment in Growth → Experiments.`,
          evidence: { steps, worstStep: worstStepName },
        });
      }
    }

    res.json(response);
  });

  return router;
}
