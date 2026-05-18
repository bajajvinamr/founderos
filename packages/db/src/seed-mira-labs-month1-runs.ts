/**
 * seed-mira-labs-month1-runs.ts — Wave 1 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent A):
 *   - composio_connections : UPDATE 3 (Slack/Gmail/Stripe → active), INSERT 2 (linkedin/hubspot)
 *   - agent_config_revisions : 1 row (Theo's Day 18 prompt swap)
 *   - routines : 3 (Iris monthly retainer, Iris Friday digest, Maya daily brief)
 *   - routine_triggers : 3 (one per routine, kind='schedule')
 *   - routine_runs : ~40 historical firings, mostly issue_created/completed
 *   - heartbeat_runs : 175 (Maya 50, Theo 90, Iris 35 — per spec §3.3)
 *   - heartbeat_run_events : ~1000 (2-6 per run)
 *   - activity_log : ~80 run-related state transitions
 *
 * Output: writes .planning/loop-2026-05-13-04/seeded-ids/runs.json so downstream
 * waves (B Issues, C Inbox, F Finance) can FK against the heartbeat_run UUIDs.
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-runs.ts
 *
 * Re-run safety: every insert uses onConflictDoNothing on natural UNIQUE
 * constraints. The whole script is wrapped in a transaction so partial
 * failures roll back cleanly. Re-running on top of a successful run is a
 * no-op (zero new rows).
 *
 * Hard limits (council carries from main seed):
 *   - NEVER set companies.is_demo = true  (DB trigger 0109 rejects)
 *   - NEVER INSERT into instance_api_keys (council condition #4)
 *   - All metadata jsonb columns tagged { persona: "mira-labs-dogfood" }
 *   - All timestamps in the past (cap at "now")
 */

import { sql, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./client.js";
import {
  companies,
  agents,
  composioConnections,
  integrations,
  agentConfigRevisions,
  heartbeatRuns,
  heartbeatRunEvents,
  routines,
  routineTriggers,
  routineRuns,
  activityLog,
} from "./schema/index.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-runs] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-runs] DATABASE_URL is required");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "seed-mira-labs-month1-runs: refused — NODE_ENV=production. " +
    "This seed performs onConflictDoUpdate against companies/integrations/" +
    "composioConnections and would overwrite live customer state. " +
    "Run only against demo or dogfood environments."
  );
}

const PERSONA_TAG = "mira-labs-dogfood";
const ANITA_AUTH_UID = "9b29fdf9-2ddb-4919-8fd2-77e4640849c9";

// ─── Time helpers ─────────────────────────────────────────────────────────────
// All temporal anchors are IST (UTC+05:30). Day 1 = 2026-04-13 (Mon).
// "Today" = 2026-05-13 (Wed). Never emit timestamps after `RUN_NOW`.
const IST_OFFSET_MIN = 330; // +05:30
const RUN_NOW = new Date("2026-05-13T08:30:00+05:30"); // Wed morning IST

/** Build a Date from IST wall-clock components. */
function ist(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  // Construct as UTC then subtract IST offset to recover the wall-clock-IST instant.
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(utc - IST_OFFSET_MIN * 60_000);
}

/** Add minutes to a Date. */
function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

function clampToRunNow(d: Date): Date {
  return d.getTime() > RUN_NOW.getTime() ? RUN_NOW : d;
}

// ─── DB setup ─────────────────────────────────────────────────────────────────
const db = createDb(DATABASE_URL);

console.log("[seed-mira-labs-month1-runs] Looking up Mira Labs company + agents…");

// Use raw SQL because `companies.metadata` column was added by a sibling
// migration that may not be reflected in this branch's Drizzle schema export.
// The DB column exists (migration 0119 / PR #163 territory) — schema TS lag is
// orthogonal. Query it directly via information-shape `metadata->>'persona'`.
const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];

if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-runs] Mira Labs company not found. Run scripts/seed-mira-labs.ts first.",
  );
  process.exit(1);
}
const MIRA = companyRow.id;

const agentRows = await db
  .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
  .from(agents)
  .where(eq(agents.companyId, MIRA));

const findAgent = (name: string) => {
  const a = agentRows.find((r) => r.name === name);
  if (!a) throw new Error(`Agent not found: ${name}`);
  return a;
};
const MAYA = findAgent("Maya");
const THEO = findAgent("Theo");
const IRIS = findAgent("Iris");

console.log(
  `[seed-mira-labs-month1-runs] MIRA=${MIRA} MAYA=${MAYA.id} THEO=${THEO.id} IRIS=${IRIS.id}`,
);

// ─── Run-plan generator ───────────────────────────────────────────────────────
// Spec §3.3: Maya 50, Theo 90, Iris 35 = 175. Status mix: 158 succeeded /
// 11 failed / 3 timed_out / 1 cancelled / 2 running.
//
// We generate the plan deterministically here so re-runs produce the same set
// of (started_at, agent, status) tuples; the natural idempotency anchor is the
// (company_id, agent_id, started_at) triplet which we treat as a soft key by
// querying before insert. New runs only insert if no existing row matches.

type RunPlan = {
  agent: "maya" | "theo" | "iris";
  startedAt: Date;
  durationMs: number;
  status:
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "running";
  invocationSource: "scheduled" | "on_demand" | "wakeup";
  errorCode?: string;
  retryOf?: number; // index in plan
  // narrative hooks
  narrative?: string;
};

const plan: RunPlan[] = [];

// Helper to count weekday (Mon=1..Fri=5) in IST
function istWeekday(d: Date): number {
  // Compute IST wall-clock day-of-week by shifting +330min.
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCDay(); // 0=Sun..6=Sat
}

function isWeekday(d: Date): boolean {
  const w = istWeekday(d);
  return w >= 1 && w <= 5;
}

// ───── Maya: 50 runs ─────
// Pattern: 1 morning weekday run + 1 evening wakeup most days. Saturday 1 run.
// Sunday skip (except Apr 13 Day-1 hello-world, which IS a Monday — so spec wording
// uses "Sundays skip" — Apr 13 is a Monday, no conflict).
// 2 failures: Apr 14 composio_rate_limit (morning), May 5 anthropic_overloaded (morning).
// Each failure has a retryOf successor that succeeded.
// 1 "running" (today's morning brief is still in flight = the current heartbeat).
{
  const mayaRuns: RunPlan[] = [];
  // Iterate days Apr 13 (Mon) → May 13 (Wed). For each weekday, add morning brief.
  // For evening, add wakeup most days. Saturdays single morning run. Sundays skip.
  // The Day-1 hello-world is Apr 13 morning, brief is sparse — same pattern.
  const dayStart = ist(2026, 4, 13, 0, 0);
  for (let dayIdx = 0; dayIdx <= 30; dayIdx++) {
    const dayBase = new Date(dayStart.getTime() + dayIdx * 86_400_000);
    const wd = istWeekday(dayBase);
    if (wd === 0) continue; // Sunday: skip
    // Morning brief: 07:00-09:30 IST
    const morningMinute = 0 + ((dayIdx * 13) % 90);
    const morningTime = addMinutes(
      new Date(dayBase.getTime() + (7 * 60) * 60_000),
      morningMinute,
    );
    // Don't emit if in the future
    if (morningTime.getTime() > RUN_NOW.getTime()) continue;

    let status: RunPlan["status"] = "succeeded";
    let errorCode: string | undefined;

    // Day 2 (Apr 14, Tue) morning fail
    if (dayIdx === 1) {
      status = "failed";
      errorCode = "composio_rate_limit";
    }
    // Day 23 (May 5 Tue) morning fail (Anthropic overloaded)
    if (dayIdx === 22) {
      status = "failed";
      errorCode = "anthropic_overloaded";
    }
    // Today's morning (May 13 Wed = dayIdx 30): still running
    if (dayIdx === 30) {
      status = "running";
    }

    mayaRuns.push({
      agent: "maya",
      startedAt: morningTime,
      durationMs: 6_000 + ((dayIdx * 137) % 6000),
      status,
      invocationSource: "scheduled",
      errorCode,
      narrative: status === "running" ? "today's brief in flight" : "morning brief",
    });

    // Evening wakeup: only on weekdays, ~70% of the time
    if (wd >= 1 && wd <= 5) {
      // Pseudo-random: skip every 4th weekday eve
      if (dayIdx % 4 !== 3) {
        const eveTime = addMinutes(
          new Date(dayBase.getTime() + (18 * 60) * 60_000),
          ((dayIdx * 47) % 180),
        );
        if (eveTime.getTime() <= RUN_NOW.getTime()) {
          mayaRuns.push({
            agent: "maya",
            startedAt: eveTime,
            durationMs: 4_000 + ((dayIdx * 53) % 4000),
            status: "succeeded",
            invocationSource: "wakeup",
            narrative: "evening wakeup",
          });
        }
      }
    }
  }

  // Trim/pad to exactly 50.
  while (mayaRuns.length > 50) {
    // Drop the most filler weekday eve.
    const idx = mayaRuns.findIndex(
      (r) => r.invocationSource === "wakeup" && r.status === "succeeded",
    );
    if (idx < 0) break;
    mayaRuns.splice(idx, 1);
  }
  while (mayaRuns.length < 50) {
    // Pad with extra on-demand runs near the end of the window.
    const t = addMinutes(new Date(RUN_NOW.getTime() - 86_400_000 * 2), mayaRuns.length * 7);
    mayaRuns.push({
      agent: "maya",
      startedAt: t,
      durationMs: 5_000,
      status: "succeeded",
      invocationSource: "on_demand",
      narrative: "filler on-demand",
    });
  }

  // Add retry rows for the 2 failures (they succeeded 30min later).
  // Replace the last 2 filler succeeded runs with these retries to keep count = 50.
  const failIdxs: number[] = [];
  mayaRuns.forEach((r, i) => {
    if (r.status === "failed") failIdxs.push(i);
  });
  for (const fi of failIdxs) {
    // Find a filler to replace.
    const fillerIdx = mayaRuns.findIndex(
      (r, idx) =>
        idx !== fi && r.invocationSource === "on_demand" && r.narrative === "filler on-demand",
    );
    if (fillerIdx >= 0) {
      mayaRuns[fillerIdx] = {
        agent: "maya",
        startedAt: addMinutes(mayaRuns[fi]!.startedAt, 30),
        durationMs: 6_500,
        status: "succeeded",
        invocationSource: "on_demand",
        retryOf: fi,
        narrative: "retry-after-failure",
      };
    }
  }

  plan.push(...mayaRuns);
}

// ───── Theo: 90 runs ─────
// Pattern: bursty workday clusters (3-6 runs) on Days 8, 9, 17, 22, 26, 27, 30.
// Filler: 0-1 per workday otherwise. Never weekends.
// 8 failures, 2 timed_out, 1 cancelled (Day 18 Verdant Foods mid-flight pivot),
// 1 running (today).
{
  const theoRuns: RunPlan[] = [];
  const dayStart = ist(2026, 4, 13, 0, 0);
  const burstDays = new Set([7, 8, 16, 21, 25, 26, 29]); // 0-indexed (Day N = idx N-1)
  for (let dayIdx = 0; dayIdx <= 30; dayIdx++) {
    const dayBase = new Date(dayStart.getTime() + dayIdx * 86_400_000);
    if (!isWeekday(dayBase)) continue;
    const isBurst = burstDays.has(dayIdx);
    const count = isBurst ? 4 + (dayIdx % 3) : dayIdx % 4 === 0 ? 1 : 0;
    for (let k = 0; k < count; k++) {
      const t = addMinutes(
        new Date(dayBase.getTime() + (10 * 60) * 60_000),
        k * 90 + ((dayIdx * 13) % 30),
      );
      if (t.getTime() > RUN_NOW.getTime()) continue;
      theoRuns.push({
        agent: "theo",
        startedAt: t,
        durationMs: 8_000 + ((dayIdx * 31 + k * 47) % 12_000),
        status: "succeeded",
        invocationSource: "on_demand",
        narrative: isBurst ? "burst-drafting" : "filler-draft",
      });
    }
  }

  while (theoRuns.length > 90) {
    const idx = theoRuns.findIndex((r) => r.narrative === "filler-draft");
    if (idx < 0) break;
    theoRuns.splice(idx, 1);
  }
  while (theoRuns.length < 90) {
    const t = addMinutes(new Date(RUN_NOW.getTime() - 86_400_000), theoRuns.length * 11);
    theoRuns.push({
      agent: "theo",
      startedAt: t,
      durationMs: 7_000,
      status: "succeeded",
      invocationSource: "on_demand",
      narrative: "filler-draft",
    });
  }

  // Apply status overlay: 8 failures, 2 timeouts, 1 cancelled, 1 running.
  // Sort by index of run within plan (we still have control here).
  // Find indices to flip.
  // 3 OpenAI rate limits: Day 12 (Apr 24) + 2 others.
  const failures: { code: string; needle?: string }[] = [
    { code: "openai_rate_limit_429" },
    { code: "openai_rate_limit_429" },
    { code: "openai_rate_limit_429" },
    { code: "prompt_validation_failed" },
    { code: "prompt_validation_failed" },
    { code: "max_turns_reached" },
    { code: "max_turns_reached" },
    { code: "session_id_mismatch" },
  ];
  // Spread fail markers across the array — pick every ~10th run.
  let failPicked = 0;
  for (let i = 5; i < theoRuns.length && failPicked < failures.length; i += 11) {
    if (theoRuns[i]!.status === "succeeded") {
      theoRuns[i]!.status = "failed";
      theoRuns[i]!.errorCode = failures[failPicked]!.code;
      failPicked++;
    }
  }
  // 2 timeouts.
  let timeoutPicked = 0;
  for (let i = 8; i < theoRuns.length && timeoutPicked < 2; i += 17) {
    if (theoRuns[i]!.status === "succeeded") {
      theoRuns[i]!.status = "timed_out";
      theoRuns[i]!.errorCode = "timeout_90s";
      theoRuns[i]!.durationMs = 90_000;
      timeoutPicked++;
    }
  }
  // 1 cancelled — pick one near Day 18 (Apr 30).
  for (let i = theoRuns.length - 1; i >= 0; i--) {
    const r = theoRuns[i]!;
    const t = r.startedAt.getTime();
    // Day 18 (Apr 30 IST) range
    if (
      r.status === "succeeded" &&
      t >= ist(2026, 4, 30, 0, 0).getTime() &&
      t <= ist(2026, 4, 30, 23, 59).getTime()
    ) {
      r.status = "cancelled";
      r.narrative = "verdant-cancelled-by-pivot";
      break;
    }
  }
  // Backstop: if Day 18 had no Theo run, force one of the remaining successes to cancelled.
  if (!theoRuns.some((r) => r.status === "cancelled")) {
    for (let i = theoRuns.length - 1; i >= 0; i--) {
      if (theoRuns[i]!.status === "succeeded") {
        theoRuns[i]!.status = "cancelled";
        theoRuns[i]!.narrative = "verdant-cancelled-by-pivot";
        break;
      }
    }
  }
  // 1 running — pick the very last one (closest to RUN_NOW).
  theoRuns.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (let i = theoRuns.length - 1; i >= 0; i--) {
    if (theoRuns[i]!.status === "succeeded") {
      theoRuns[i]!.status = "running";
      theoRuns[i]!.narrative = "in-flight";
      break;
    }
  }

  plan.push(...theoRuns);
}

// ───── Iris: 35 runs ─────
// Pattern: spike days Apr 15 (Day 3) and May 1 (Day 19) — 4-5 runs each.
// Plus 1-2 on-demand per week. Weekend runs ~2 over 30d (Stripe webhook wakeups).
// 1 failure (Apr 30 stripe_timeout), 1 timed_out (Day 19 long retainer summary).
{
  const irisRuns: RunPlan[] = [];
  const dayStart = ist(2026, 4, 13, 0, 0);
  // Spike days
  const spikeDays = [2, 18]; // Apr 15 (idx 2), May 1 (idx 18)
  for (const dayIdx of spikeDays) {
    const dayBase = new Date(dayStart.getTime() + dayIdx * 86_400_000);
    for (let k = 0; k < 5; k++) {
      const t = addMinutes(
        new Date(dayBase.getTime() + 9 * 60 * 60_000),
        k * 40,
      );
      if (t.getTime() > RUN_NOW.getTime()) continue;
      irisRuns.push({
        agent: "iris",
        startedAt: t,
        durationMs: 7_000 + ((dayIdx * 13 + k * 29) % 5000),
        status: "succeeded",
        invocationSource: "scheduled",
        narrative: dayIdx === 2 ? "apr15-retainer-spike" : "may1-retainer-spike",
      });
    }
  }
  // Weekly on-demand: spread Tuesday/Thursday across 4 weeks
  for (const offset of [1, 3, 8, 10, 15, 17, 24, 26]) {
    const dayBase = new Date(dayStart.getTime() + offset * 86_400_000);
    const t = addMinutes(new Date(dayBase.getTime() + 14 * 60 * 60_000), (offset * 11) % 60);
    if (t.getTime() > RUN_NOW.getTime()) continue;
    irisRuns.push({
      agent: "iris",
      startedAt: t,
      durationMs: 6_000,
      status: "succeeded",
      invocationSource: "on_demand",
      narrative: "iris-on-demand",
    });
  }
  // Friday digest runs (Apr 17, Apr 24, May 1, May 8) — already partially seeded
  // by spike days, but the Friday digest is a distinct routine. Two extra Fridays.
  for (const offset of [4, 11]) {
    const dayBase = new Date(dayStart.getTime() + offset * 86_400_000);
    const t = addMinutes(new Date(dayBase.getTime() + 17 * 60 * 60_000), 0);
    if (t.getTime() > RUN_NOW.getTime()) continue;
    irisRuns.push({
      agent: "iris",
      startedAt: t,
      durationMs: 5_500,
      status: "succeeded",
      invocationSource: "scheduled",
      narrative: "friday-digest",
    });
  }
  // Weekend wakeups (~2)
  for (const offset of [5, 12]) {
    const dayBase = new Date(dayStart.getTime() + offset * 86_400_000);
    const t = addMinutes(new Date(dayBase.getTime() + 11 * 60 * 60_000), 12);
    if (t.getTime() > RUN_NOW.getTime()) continue;
    irisRuns.push({
      agent: "iris",
      startedAt: t,
      durationMs: 4_800,
      status: "succeeded",
      invocationSource: "wakeup",
      narrative: "weekend-stripe-wakeup",
    });
  }

  // Trim/pad to 35.
  while (irisRuns.length > 35) {
    const idx = irisRuns.findIndex((r) => r.narrative === "iris-on-demand");
    if (idx < 0) break;
    irisRuns.splice(idx, 1);
  }
  while (irisRuns.length < 35) {
    const t = addMinutes(new Date(RUN_NOW.getTime() - 86_400_000 * 4), irisRuns.length * 13);
    irisRuns.push({
      agent: "iris",
      startedAt: t,
      durationMs: 5_000,
      status: "succeeded",
      invocationSource: "on_demand",
      narrative: "filler-iris",
    });
  }

  // 1 failure (Apr 30 stripe_timeout): find run on Apr 30 or nearest.
  let pickedFail = false;
  for (let i = 0; i < irisRuns.length; i++) {
    const t = irisRuns[i]!.startedAt.getTime();
    if (
      irisRuns[i]!.status === "succeeded" &&
      t >= ist(2026, 4, 30, 0, 0).getTime() &&
      t <= ist(2026, 4, 30, 23, 59).getTime()
    ) {
      irisRuns[i]!.status = "failed";
      irisRuns[i]!.errorCode = "stripe_timeout";
      pickedFail = true;
      break;
    }
  }
  if (!pickedFail) {
    for (let i = 0; i < irisRuns.length; i++) {
      if (irisRuns[i]!.status === "succeeded") {
        irisRuns[i]!.status = "failed";
        irisRuns[i]!.errorCode = "stripe_timeout";
        break;
      }
    }
  }
  // 1 timed_out (Day 19 long retainer): find a May 1 run.
  let pickedTimeout = false;
  for (let i = 0; i < irisRuns.length; i++) {
    const t = irisRuns[i]!.startedAt.getTime();
    if (
      irisRuns[i]!.status === "succeeded" &&
      t >= ist(2026, 5, 1, 0, 0).getTime() &&
      t <= ist(2026, 5, 1, 23, 59).getTime()
    ) {
      irisRuns[i]!.status = "timed_out";
      irisRuns[i]!.errorCode = "timeout_90s";
      irisRuns[i]!.durationMs = 90_000;
      pickedTimeout = true;
      break;
    }
  }
  if (!pickedTimeout) {
    for (let i = 0; i < irisRuns.length; i++) {
      if (irisRuns[i]!.status === "succeeded") {
        irisRuns[i]!.status = "timed_out";
        irisRuns[i]!.errorCode = "timeout_90s";
        irisRuns[i]!.durationMs = 90_000;
        break;
      }
    }
  }

  plan.push(...irisRuns);
}

// Sort plan globally by startedAt so seq monotonicity in events is easy.
plan.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

console.log(
  `[seed-mira-labs-month1-runs] Plan: ${plan.length} runs total (Maya=${plan.filter((p) => p.agent === "maya").length} Theo=${plan.filter((p) => p.agent === "theo").length} Iris=${plan.filter((p) => p.agent === "iris").length})`,
);

// ─── Cost/usage shape helpers ─────────────────────────────────────────────────
function mayaUsage(durationMs: number) {
  const inputTokens = 4000 + ((durationMs * 7) % 2000);
  const outputTokens = 700 + ((durationMs * 3) % 500);
  const cachedInputTokens = Math.floor(inputTokens * 0.25);
  const costUsd = Number(((inputTokens * 0.000015) + (outputTokens * 0.000075)).toFixed(3));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    model: "claude-opus-4-6",
    cost_usd: costUsd,
    duration_ms: durationMs,
  };
}
function theoUsage(durationMs: number) {
  const inputTokens = 2500 + ((durationMs * 5) % 1500);
  const outputTokens = 600 + ((durationMs * 3) % 400);
  const costUsd = Number(((inputTokens * 0.0000015) + (outputTokens * 0.000006)).toFixed(3));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: "gpt-4.1-mini",
    cost_usd: costUsd,
    duration_ms: durationMs,
  };
}
function irisUsage(durationMs: number) {
  const inputTokens = 3500 + ((durationMs * 5) % 1500);
  const outputTokens = 500 + ((durationMs * 3) % 400);
  const cachedInputTokens = Math.floor(inputTokens * 0.2);
  const costUsd = Number(((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(3));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    model: "claude-sonnet-4-6",
    cost_usd: costUsd,
    duration_ms: durationMs,
  };
}

function usageFor(p: RunPlan): Record<string, unknown> {
  if (p.agent === "maya") return mayaUsage(p.durationMs);
  if (p.agent === "theo") return theoUsage(p.durationMs);
  return irisUsage(p.durationMs);
}

function resultFor(p: RunPlan, idx: number): Record<string, unknown> | null {
  if (p.status !== "succeeded") return null;
  if (p.agent === "maya") {
    const forDate = istLocalDate(p.startedAt);
    return {
      brief_generated_for: forDate,
      approvals_surfaced: (idx % 3),
      blockers_count: (idx % 2),
    };
  }
  if (p.agent === "theo") {
    return {
      drafted_format: "proposal",
      client_name: pickClient(idx),
      word_count: 320 + (idx * 17) % 200,
    };
  }
  return {
    stripe_invoices_checked: 4,
    overdue_count: idx % 3 === 0 ? 1 : 0,
    summaries_drafted: idx % 5 === 0 ? 4 : 0,
    approvals_queued: idx % 7 === 0 ? 1 : 0,
  };
}

function pickClient(seed: number): string {
  const clients = [
    "Shore Capital",
    "Clearview Legal",
    "Northwood Dental",
    "Bake House",
    "Acme Retail",
    "Fielding Logistics",
    "SkyBridge Insurance",
  ];
  return clients[seed % clients.length]!;
}

function istLocalDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function stdoutFor(p: RunPlan, idx: number): string {
  if (p.status === "failed") {
    return `[${p.agent}] Run failed (${p.errorCode}). See stderr for trace.`;
  }
  if (p.status === "timed_out") {
    return `[${p.agent}] Run timed out after ${(p.durationMs / 1000).toFixed(0)}s.`;
  }
  if (p.status === "cancelled") {
    return `[${p.agent}] Run cancelled mid-flight (${p.narrative ?? "user_cancelled"}).`;
  }
  if (p.status === "running") {
    return `[${p.agent}] In flight — streaming output…`;
  }
  if (p.agent === "maya") return `[Maya] Daily brief drafted · approvals_surfaced=${idx % 3} · cost ~$${mayaUsage(p.durationMs).cost_usd}`;
  if (p.agent === "theo") {
    const c = pickClient(idx);
    return `[Theo] Drafted proposal for ${c} · ~${320 + (idx * 17) % 200} words · pricing $1,500/mo + $2,500 setup`;
  }
  return `[Iris] Stripe scan complete · 4 invoices checked · ${idx % 3 === 0 ? "1 overdue flagged" : "no overdue"}`;
}

function stderrFor(p: RunPlan): string | null {
  if (p.status === "failed") {
    return `Error: ${p.errorCode}. Retry queued.`;
  }
  if (p.status === "timed_out") {
    return `Timed out after ${(p.durationMs / 1000).toFixed(0)}s. Operation aborted.`;
  }
  if (p.status === "cancelled") {
    return `Cancelled by user (${p.narrative ?? "manual"}).`;
  }
  return null;
}

function agentIdFor(p: RunPlan): string {
  if (p.agent === "maya") return MAYA.id;
  if (p.agent === "theo") return THEO.id;
  return IRIS.id;
}

// ─── Main transaction ─────────────────────────────────────────────────────────
const summary = {
  composioUpdated: 0,
  composioInserted: 0,
  agentConfigRevisions: 0,
  heartbeatRuns: 0,
  heartbeatRunEvents: 0,
  routines: 0,
  routineTriggers: 0,
  routineRuns: 0,
  activityLog: 0,
};

await db.transaction(async (tx) => {
  // ─── 1. composio_connections ────────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-runs] composio_connections…");
  const lastSync = new Date(RUN_NOW.getTime() - 10 * 60_000);
  const composioPlans = [
    { app: "slack", connId: "ca_mira_slack_4f7a9b" },
    { app: "gmail", connId: "ca_mira_gmail_3d8e21" },
    { app: "stripe", connId: "ca_mira_stripe_71b6c4" },
  ];
  for (const cp of composioPlans) {
    const updated = await tx
      .update(composioConnections)
      .set({
        status: "active",
        lastSyncAt: lastSync,
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        composioConnectionId: cp.connId,
        updatedAt: lastSync,
      })
      .where(
        sql`${composioConnections.companyId} = ${MIRA}::uuid AND ${composioConnections.appName} = ${cp.app}`,
      )
      .returning({ id: composioConnections.id });
    summary.composioUpdated += updated.length;
  }

  // Insert 2 new: linkedin (active), hubspot (failed)
  await tx
    .insert(composioConnections)
    .values([
      {
        companyId: MIRA,
        userId: ANITA_AUTH_UID,
        appName: "linkedin",
        composioConnectionId: "ca_mira_linkedin_92f1aa",
        status: "active",
        lastSyncAt: new Date(RUN_NOW.getTime() - 22 * 60_000),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
      },
      {
        companyId: MIRA,
        userId: ANITA_AUTH_UID,
        appName: "hubspot",
        composioConnectionId: "ca_mira_hubspot_77ade5",
        status: "failed",
        lastSyncAt: ist(2026, 5, 8, 14, 32),
        lastSyncStatus: "fail",
        lastError:
          "OAuth refresh token expired 2026-05-08; reconnect required",
        consecutiveFailures: 3,
      },
    ])
    .onConflictDoNothing();
  // Count inserted rows (re-query to be precise)
  const composioAfter = await tx
    .select({ id: composioConnections.id, app: composioConnections.appName })
    .from(composioConnections)
    .where(eq(composioConnections.companyId, MIRA));
  summary.composioInserted = composioAfter.filter(
    (r) => r.app === "linkedin" || r.app === "hubspot",
  ).length;

  // Keep the legacy Integrations page populated as well. The Composio rows
  // drive OAuth-aware execution, while `integrations` powers the founder-facing
  // connection grid at /integrations.
  const integrationRows = [
    {
      kind: "stripe",
      status: "connected",
      keyHint: "OAuth",
      config: {
        accountName: "Mira Labs Stripe",
        accountId: "acct_mira_demo",
        mrrCents: 640_000,
        overdueInvoices: 1,
      },
      lastError: null,
      connectedAt: ist(2026, 4, 14, 18, 12),
    },
    {
      kind: "slack",
      status: "connected",
      keyHint: "OAuth",
      config: {
        workspaceName: "Mira Labs",
        channels: [
          { id: "C_MIRA_TEAM", name: "mira-team", isPrivate: false },
          { id: "C_CLIENTS", name: "client-updates", isPrivate: true },
          { id: "C_FINANCE", name: "mira-finance", isPrivate: true },
        ],
      },
      lastError: null,
      connectedAt: ist(2026, 4, 13, 11, 12),
    },
    {
      kind: "hubspot",
      status: "error",
      keyHint: "OAuth",
      config: {
        portalName: "Mira Labs CRM",
        openDeals: 3,
        pipelineCents: 720_000,
      },
      lastError: "OAuth refresh token expired 2026-05-08; reconnect required",
      connectedAt: ist(2026, 5, 8, 14, 32),
    },
    {
      kind: "linkedin",
      status: "connected",
      keyHint: "OAuth",
      config: {
        profile: "Anita Mehra",
        weeklyOutboundLimit: 25,
        warmIntrosQueued: 4,
      },
      lastError: null,
      connectedAt: ist(2026, 4, 22, 15, 4),
    },
  ];
  const now = RUN_NOW;
  for (const row of integrationRows) {
    await tx.insert(integrations).values({
      companyId: MIRA,
      kind: row.kind,
      status: row.status,
      keyHint: row.keyHint,
      encryptedApiKey: null,
      config: row.config,
      lastError: row.lastError,
      connectedAt: row.connectedAt,
      createdAt: row.connectedAt,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [integrations.companyId, integrations.kind],
      set: {
        status: row.status,
        keyHint: row.keyHint,
        config: row.config,
        lastError: row.lastError,
        connectedAt: row.connectedAt,
        updatedAt: now,
      },
    });
  }

  // ─── 2. agent_config_revisions ──────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-runs] agent_config_revisions…");

  // Idempotency: check if a revision already exists at the Day-18 timestamp.
  const day18Time = ist(2026, 4, 30, 14, 22);
  const existingRev = await tx
    .select({ id: agentConfigRevisions.id })
    .from(agentConfigRevisions)
    .where(
      sql`${agentConfigRevisions.agentId} = ${THEO.id}::uuid AND ${agentConfigRevisions.createdAt} = ${day18Time.toISOString()}::timestamptz`,
    );
  if (existingRev.length === 0) {
    const currentTheoCfg = (THEO.adapterConfig ?? {}) as Record<string, unknown>;
    const prevAdapterConfig = {
      ...currentTheoCfg,
      promptTemplate:
        "You are Theo, Growth & BD agent at Mira Labs. We work primarily with manufacturing SMBs (20-200 staff) — floor automation, MES integrations, ERP back-office. When given a discovery call transcript, produce a proposal emphasising operational efficiency, throughput gains, and shop-floor data capture. Standard pricing: $1,500-$3,000/mo retainer + $2,500-$5,000 setup. Be concrete about hours saved on the floor.",
    };
    const newAdapterConfig = {
      ...currentTheoCfg,
      promptTemplate:
        "You are Theo, Growth & BD agent at Mira Labs, an AI automation consultancy focused on professional services (legal, PE/finance, insurance). When given a discovery call transcript, produce a client proposal emphasising compliance-grade document extraction, clause-level review, and audit-ready reporting. Pricing: $1,500-$3,000/mo retainer + $2,500-$5,000 setup. Style: consultancy-grade, compliance-aware.",
    };
    await tx.insert(agentConfigRevisions).values({
      companyId: MIRA,
      agentId: THEO.id,
      createdByAgentId: null,
      createdByUserId: ANITA_AUTH_UID,
      source: "patch",
      changedKeys: ["promptTemplate"],
      beforeConfig: prevAdapterConfig,
      afterConfig: newAdapterConfig,
      createdAt: day18Time,
    });
    summary.agentConfigRevisions = 1;
  }

  // ─── 3. routines ─────────────────────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-runs] routines + triggers + runs…");

  type SeededRoutine = {
    id: string;
    title: string;
    triggerId: string;
  };
  const seededRoutines: Record<string, SeededRoutine> = {};

  type RoutineDef = {
    key: "iris_retainer" | "iris_friday" | "maya_brief";
    title: string;
    description: string;
    assignee: string;
    priority: "critical" | "high" | "medium";
    concurrencyPolicy: string;
    catchUpPolicy: string;
    cron: string;
    nextRunDayOffset: number;
  };

  const routineDefs: RoutineDef[] = [
    {
      key: "iris_retainer",
      title: "Iris monthly retainer summaries",
      description:
        "On the 1st and 15th of each month, Iris drafts a 1-page retainer summary for every active client (Stripe-active subscription). Creates an approval per draft for Anita to review.",
      assignee: IRIS.id,
      priority: "high",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "enqueue_missed_with_cap",
      cron: "0 9 1,15 * *",
      nextRunDayOffset: 2, // 2026-05-15 09:00 IST
    },
    {
      key: "iris_friday",
      title: "Iris Friday finance digest",
      description:
        "Every Friday at 17:00 IST, Iris posts a finance summary to #mira-finance: MRR, outstanding invoices, runway estimate at current burn.",
      assignee: IRIS.id,
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      cron: "0 17 * * 5",
      nextRunDayOffset: 2, // next Friday after RUN_NOW
    },
    {
      key: "maya_brief",
      title: "Maya daily brief",
      description:
        "Every weekday at 07:30 IST, Maya synthesises Slack + Gmail + pending approvals into a daily brief.",
      assignee: MAYA.id,
      priority: "critical",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      cron: "30 7 * * *",
      nextRunDayOffset: 1,
    },
  ];

  for (const rd of routineDefs) {
    // Check existing by (companyId, assignee, title) — no DB UNIQUE so we manual-dedup.
    const existing = await tx
      .select({ id: routines.id })
      .from(routines)
      .where(
        sql`${routines.companyId} = ${MIRA}::uuid AND ${routines.title} = ${rd.title}`,
      );

    let routineId: string;
    let triggerId: string;

    if (existing.length > 0) {
      routineId = existing[0]!.id;
      const tr = await tx
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(eq(routineTriggers.routineId, routineId));
      triggerId = tr[0]?.id ?? "";
    } else {
      const lastFired = new Date(RUN_NOW.getTime() - 6 * 3600_000);
      const nextRun = new Date(
        RUN_NOW.getTime() + rd.nextRunDayOffset * 86_400_000,
      );
      const [rrow] = await tx
        .insert(routines)
        .values({
          companyId: MIRA,
          title: rd.title,
          description: rd.description,
          assigneeAgentId: rd.assignee,
          priority: rd.priority,
          status: "active",
          concurrencyPolicy: rd.concurrencyPolicy,
          catchUpPolicy: rd.catchUpPolicy,
          createdByUserId: ANITA_AUTH_UID,
          lastTriggeredAt: lastFired,
          lastEnqueuedAt: lastFired,
        })
        .returning({ id: routines.id });
      routineId = rrow!.id;
      summary.routines++;

      const [trow] = await tx
        .insert(routineTriggers)
        .values({
          companyId: MIRA,
          routineId,
          kind: "schedule",
          label: rd.title,
          enabled: true,
          cronExpression: rd.cron,
          timezone: "Asia/Kolkata",
          nextRunAt: nextRun,
          lastFiredAt: lastFired,
          createdByUserId: ANITA_AUTH_UID,
        })
        .returning({ id: routineTriggers.id });
      triggerId = trow!.id;
      summary.routineTriggers++;
    }

    seededRoutines[rd.key] = {
      id: routineId,
      title: rd.title,
      triggerId,
    };
  }

  // ─── 4. routine_runs ────────────────────────────────────────────────────────
  // ~40 total: Maya weekday morning briefs (~22), Iris monthly (Apr 15, May 1)
  // each firing 4 issues, Iris Friday digest (Apr 17, Apr 24, May 1, May 8) = 4,
  // plus 1-2 coalesced.
  type RoutineRunPlan = {
    routineKey: "iris_retainer" | "iris_friday" | "maya_brief";
    triggeredAt: Date;
    status: "issue_created" | "completed" | "coalesced";
    completedAt?: Date;
  };

  const rrPlans: RoutineRunPlan[] = [];

  // Maya daily brief: each weekday from Apr 13 to May 12 (skip Sundays).
  // ~22 firings (some skipped weekends in the 30-day window).
  const dayStart = ist(2026, 4, 13, 0, 0);
  for (let dayIdx = 0; dayIdx < 30; dayIdx++) {
    const dayBase = new Date(dayStart.getTime() + dayIdx * 86_400_000);
    const wd = istWeekday(dayBase);
    if (wd === 0) continue; // Sunday
    // 07:30 IST
    const t = new Date(dayBase.getTime() + (7 * 60 + 30) * 60_000);
    if (t.getTime() > RUN_NOW.getTime()) continue;
    rrPlans.push({
      routineKey: "maya_brief",
      triggeredAt: t,
      status: "completed",
      completedAt: addMinutes(t, 1 + (dayIdx % 5)),
    });
  }

  // Iris monthly retainer (Apr 15, May 1) — 4 child issue_created firings each.
  for (const monthlyDate of [ist(2026, 4, 15, 9, 0), ist(2026, 5, 1, 9, 0)]) {
    for (let k = 0; k < 4; k++) {
      rrPlans.push({
        routineKey: "iris_retainer",
        triggeredAt: addMinutes(monthlyDate, k * 8),
        status: "issue_created",
        completedAt: addMinutes(monthlyDate, k * 8 + 6),
      });
    }
  }

  // Iris Friday finance digest (Apr 17, Apr 24, May 1, May 8)
  for (const friday of [
    ist(2026, 4, 17, 17, 0),
    ist(2026, 4, 24, 17, 0),
    ist(2026, 5, 1, 17, 0),
    ist(2026, 5, 8, 17, 0),
  ]) {
    rrPlans.push({
      routineKey: "iris_friday",
      triggeredAt: friday,
      status: "completed",
      completedAt: addMinutes(friday, 4),
    });
  }

  // 2 coalesced rows (Maya brief fired twice on Mondays after busy weekend backlog)
  for (const t of [ist(2026, 4, 20, 7, 31), ist(2026, 5, 4, 7, 31)]) {
    rrPlans.push({
      routineKey: "maya_brief",
      triggeredAt: t,
      status: "coalesced",
    });
  }

  // Idempotency key per fire
  let routineRunsInsertCount = 0;
  for (const rp of rrPlans) {
    const triggerId = seededRoutines[rp.routineKey]!.triggerId;
    const idempotencyKey = `${rp.routineKey}-${istLocalDate(rp.triggeredAt)}-${rp.triggeredAt.getUTCHours()}${rp.triggeredAt.getUTCMinutes()}`;
    // Check existing
    const exist = await tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        sql`${routineRuns.triggerId} = ${triggerId}::uuid AND ${routineRuns.idempotencyKey} = ${idempotencyKey}`,
      );
    if (exist.length > 0) continue;
    await tx.insert(routineRuns).values({
      companyId: MIRA,
      routineId: seededRoutines[rp.routineKey]!.id,
      triggerId,
      source: "schedule",
      status: rp.status,
      triggeredAt: rp.triggeredAt,
      idempotencyKey,
      triggerPayload: { persona: PERSONA_TAG, routine: rp.routineKey },
      completedAt: rp.completedAt ?? null,
    });
    routineRunsInsertCount++;
  }
  summary.routineRuns = routineRunsInsertCount;

  // ─── 5. heartbeat_runs + heartbeat_run_events ───────────────────────────────
  console.log(
    `[seed-mira-labs-month1-runs] heartbeat_runs (${plan.length}) + events…`,
  );

  // Idempotency: check if any heartbeat_runs already exist for Mira.
  const existingRuns = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, MIRA));
  if (existingRuns.length >= plan.length) {
    console.log(
      `[seed-mira-labs-month1-runs] heartbeat_runs already at target count (${existingRuns.length}). Skipping.`,
    );
  } else {
    // Wipe out partial state from a prior failed run so we can re-insert cleanly.
    // We only do this if count is strictly less than target — never if already
    // at-or-above target.
    if (existingRuns.length > 0) {
      console.log(
        `[seed-mira-labs-month1-runs] Found ${existingRuns.length} partial heartbeat_runs — clearing for clean re-insert.`,
      );
      // Also wipe events + activity_log run-refs to maintain FK integrity.
      await tx.execute(
        sql`DELETE FROM heartbeat_run_events WHERE company_id = ${MIRA}::uuid`,
      );
      await tx.execute(
        sql`DELETE FROM activity_log WHERE company_id = ${MIRA}::uuid AND run_id IS NOT NULL`,
      );
      await tx.execute(
        sql`DELETE FROM heartbeat_runs WHERE company_id = ${MIRA}::uuid`,
      );
    }

    // First pass: insert all runs without retry_of_run_id.
    const runIdByPlanIdx = new Map<number, string>();
    const rowsToInsert = plan.map((p, idx) => {
      const id = randomUUID();
      runIdByPlanIdx.set(idx, id);
      const startedAt = clampToRunNow(p.startedAt);
      const finishedAt =
        p.status === "running"
          ? null
          : clampToRunNow(new Date(startedAt.getTime() + p.durationMs));
      const result = resultFor(p, idx);
      const stdout = stdoutFor(p, idx);
      const stderr = stderrFor(p);
      return {
        id,
        companyId: MIRA,
        agentId: agentIdFor(p),
        invocationSource: p.invocationSource,
        status: p.status,
        startedAt,
        finishedAt,
        error: p.errorCode ? `${p.errorCode}: see stderr` : null,
        errorCode: p.errorCode ?? null,
        usageJson: usageFor(p),
        resultJson: result,
        stdoutExcerpt: stdout.slice(0, 480),
        stderrExcerpt: stderr ? stderr.slice(0, 480) : null,
        retryOfRunId: null as string | null,
        createdAt: startedAt,
        updatedAt: finishedAt ?? startedAt,
      };
    });

    // Bulk insert in chunks to avoid hitting parameter limits.
    const CHUNK = 50;
    for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
      await tx.insert(heartbeatRuns).values(rowsToInsert.slice(i, i + CHUNK));
    }

    // Second pass: set retryOfRunId for retry runs.
    for (let idx = 0; idx < plan.length; idx++) {
      const p = plan[idx]!;
      if (typeof p.retryOf === "number") {
        const targetId = runIdByPlanIdx.get(idx)!;
        const refId = runIdByPlanIdx.get(p.retryOf);
        if (refId) {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: refId })
            .where(eq(heartbeatRuns.id, targetId));
        }
      }
    }
    summary.heartbeatRuns = rowsToInsert.length;

    // ─── 5b. heartbeat_run_events (~1000 total) ───────────────────────────────
    // 2-6 events per run. Filler Maya morning runs get 2 (started + completed).
    // Failed runs get 3. Theo successes get 5-6. Iris 4-5.
    type EventRow = {
      companyId: string;
      runId: string;
      agentId: string;
      seq: number;
      eventType: string;
      level?: string;
      message?: string;
      payload?: Record<string, unknown>;
      createdAt: Date;
    };

    const eventRows: EventRow[] = [];
    for (let idx = 0; idx < plan.length; idx++) {
      const p = plan[idx]!;
      const runId = runIdByPlanIdx.get(idx)!;
      const startedAt = clampToRunNow(p.startedAt);
      const aid = agentIdFor(p);

      let seq = 1;
      const push = (
        eventType: string,
        offsetMs: number,
        level: string,
        message?: string,
        payload?: Record<string, unknown>,
      ) => {
        eventRows.push({
          companyId: MIRA,
          runId,
          agentId: aid,
          seq: seq++,
          eventType,
          level,
          message,
          payload,
          createdAt: clampToRunNow(new Date(startedAt.getTime() + offsetMs)),
        });
      };

      push(
        "run.started",
        0,
        "info",
        `Run started; invocationSource=${p.invocationSource}`,
      );

      if (p.status === "failed") {
        push("tool.invoked", 800, "info", undefined, {
          tool: p.agent === "maya" ? "composio.slack.read" : p.agent === "theo" ? "openai.chat" : "stripe.invoices.list",
        });
        push("run.failed", p.durationMs, "error", `Error: ${p.errorCode}`);
      } else if (p.status === "timed_out") {
        push("tool.invoked", 1200, "info", undefined, { tool: "openai.chat" });
        push("stream.output", 30_000, "info", "(partial output before timeout)");
        push("run.failed", p.durationMs, "error", `Timed out after ${(p.durationMs / 1000).toFixed(0)}s`);
      } else if (p.status === "cancelled") {
        push("tool.invoked", 600, "info", undefined, { tool: "openai.chat" });
        push("run.failed", Math.min(p.durationMs, 5_000), "warn", "Cancelled by user");
      } else if (p.status === "running") {
        push("tool.invoked", 600, "info", undefined, { tool: "anthropic.messages" });
        push("stream.output", 2_500, "info", "(still streaming…)");
      } else {
        // succeeded
        if (p.agent === "maya") {
          // All Maya morning + evening runs share the multi-tool shape.
          push("tool.invoked", 600, "info", undefined, { tool: "composio.slack.read" });
          push("tool.invoked", 1800, "info", undefined, { tool: "composio.gmail.list" });
          push("stream.output", 3200, "info", "drafting brief…");
          push("run.completed", p.durationMs, "info", `Run completed; cost ~$${(usageFor(p) as any).cost_usd}`);
        } else if (p.agent === "theo") {
          push("tool.invoked", 500, "info", undefined, { tool: "openai.chat.completions" });
          push("stream.output", 2400, "info", "drafting proposal…");
          push("stream.output", 4200, "info", "refining tone…");
          if ((idx % 3) === 0) {
            push("approval.queued", p.durationMs - 200, "info", "approval queued for review", {
              approvalId: randomUUID(),
            });
          }
          push("run.completed", p.durationMs, "info", `Run completed; tokens ~${(usageFor(p) as any).input_tokens}/${(usageFor(p) as any).output_tokens}`);
        } else {
          // iris
          push("tool.invoked", 700, "info", undefined, { tool: "composio.stripe.invoices.list" });
          push("stream.output", 2500, "info", "scanning invoices…");
          push("tool.invoked", 3500, "info", undefined, { tool: "composio.stripe.charges.list" });
          if ((idx % 5) === 0) {
            push("approval.queued", p.durationMs - 300, "info", "summary draft queued", {
              approvalId: randomUUID(),
            });
          }
          push("run.completed", p.durationMs, "info", "Run completed");
        }
      }
    }

    // Bulk insert events.
    const EVT_CHUNK = 200;
    for (let i = 0; i < eventRows.length; i += EVT_CHUNK) {
      await tx.insert(heartbeatRunEvents).values(eventRows.slice(i, i + EVT_CHUNK));
    }
    summary.heartbeatRunEvents = eventRows.length;

    // ─── 6. activity_log (run-related, ~80 rows) ─────────────────────────────
    // Spec §3.27: 1 per agent.run.started/completed/failed. Wave 1 emits the
    // ~80 run-related entries; Wave F adds the remaining ~40 non-run ones.
    //
    // Strategy: emit `agent.run.completed` for every succeeded run + `agent.run.failed`
    // for failures/timeouts. Skip "started" to keep the volume at ~80 (175 runs
    // ÷ ~2 per run + 5 integration events = ~80 target).
    // Also include 5 integration.connected rows for the composio flips.
    const activityRows: Array<{
      companyId: string;
      actorType: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      agentId?: string;
      runId?: string;
      details?: Record<string, unknown>;
      createdAt: Date;
    }> = [];

    // Spread activity entries across runs — about every other run.
    for (let idx = 0; idx < plan.length; idx++) {
      const p = plan[idx]!;
      // To keep activity_log ~80, emit on every ~2nd run.
      if (idx % 2 !== 0 && p.status === "succeeded") continue;

      const runId = runIdByPlanIdx.get(idx)!;
      const startedAt = clampToRunNow(p.startedAt);
      const finishedAt =
        p.status === "running"
          ? startedAt
          : clampToRunNow(new Date(startedAt.getTime() + p.durationMs));

      let action: string;
      if (p.status === "succeeded") action = "agent.run.completed";
      else if (p.status === "failed" || p.status === "timed_out") action = "agent.run.failed";
      else if (p.status === "cancelled") action = "agent.run.cancelled";
      else action = "agent.run.started";

      activityRows.push({
        companyId: MIRA,
        actorType: "agent",
        actorId: agentIdFor(p),
        action,
        entityType: "heartbeat_run",
        entityId: runId,
        agentId: agentIdFor(p),
        runId,
        details: {
          status: p.status,
          errorCode: p.errorCode ?? null,
          persona: PERSONA_TAG,
        },
        createdAt: finishedAt,
      });
    }

    // 5 integration.connected rows (3 flipped to active + 2 new)
    const integrationTs = ist(2026, 4, 13, 11, 12);
    const intMap = [
      { app: "slack", ts: integrationTs, status: "active" },
      { app: "gmail", ts: addMinutes(integrationTs, 23), status: "active" },
      { app: "stripe", ts: ist(2026, 4, 14, 18, 12), status: "active" },
      { app: "linkedin", ts: ist(2026, 4, 22, 15, 4), status: "active" },
      { app: "hubspot", ts: ist(2026, 5, 8, 14, 32), status: "failed" },
    ];
    for (const e of intMap) {
      activityRows.push({
        companyId: MIRA,
        actorType: "user",
        actorId: ANITA_AUTH_UID,
        action: e.status === "active" ? "integration.connected" : "integration.failed",
        entityType: "composio_connection",
        entityId: e.app,
        details: {
          app: e.app,
          status: e.status,
          persona: PERSONA_TAG,
        },
        createdAt: e.ts,
      });
    }

    // Bulk insert activity_log.
    const ACT_CHUNK = 100;
    for (let i = 0; i < activityRows.length; i += ACT_CHUNK) {
      await tx.insert(activityLog).values(activityRows.slice(i, i + ACT_CHUNK));
    }
    summary.activityLog = activityRows.length;

    // ─── 7. Emit runs.json for downstream waves ──────────────────────────────
    const runsJson: Record<string, string> = {};
    for (let idx = 0; idx < plan.length; idx++) {
      const p = plan[idx]!;
      const key = `${istLocalDate(p.startedAt)}:${p.agent}:${idx}`;
      runsJson[key] = runIdByPlanIdx.get(idx)!;
    }
    // Best-effort write — walk up from cwd until we find an existing
    // `.planning/loop-2026-05-13-04` directory. This puts runs.json at the
    // repo root regardless of whether the script was invoked from repo root
    // or packages/db. We DO NOT create a fresh .planning/ at cwd if none is
    // found — that would scatter stray planning dirs into subpackages.
    try {
      let base = process.cwd();
      let found = false;
      for (let hop = 0; hop < 6; hop++) {
        if (existsSync(`${base}/.planning/loop-2026-05-13-04`)) {
          found = true;
          break;
        }
        const parent = dirname(base);
        if (parent === base) break;
        base = parent;
      }
      if (!found) {
        console.warn(
          "[seed-mira-labs-month1-runs] No .planning/loop-2026-05-13-04 dir found above cwd — skipping runs.json write.",
        );
      } else {
        const outPath = `${base}/.planning/loop-2026-05-13-04/seeded-ids/runs.json`;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(runsJson, null, 2));
        console.log(`[seed-mira-labs-month1-runs] Wrote ${Object.keys(runsJson).length} run IDs → ${outPath}`);
      }
    } catch (e) {
      console.warn(
        `[seed-mira-labs-month1-runs] Could not write runs.json (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
});

// ─── End-of-run summary ───────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-runs] Inserted/updated:
  composio_connections (updated)  : ${summary.composioUpdated}
  composio_connections (inserted) : ${summary.composioInserted}
  agent_config_revisions          : ${summary.agentConfigRevisions}
  routines                        : ${summary.routines}
  routine_triggers                : ${summary.routineTriggers}
  routine_runs                    : ${summary.routineRuns}
  heartbeat_runs                  : ${summary.heartbeatRuns}
  heartbeat_run_events            : ${summary.heartbeatRunEvents}
  activity_log                    : ${summary.activityLog}
`);

process.exit(0);
