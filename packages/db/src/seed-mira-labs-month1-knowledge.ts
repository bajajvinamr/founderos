/**
 * seed-mira-labs-month1-knowledge.ts — Wave 4 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent D):
 *   - company_memory     : 12 rows  (per spec §3.15; pinned: #2, #6, #11)
 *   - insights           : 15 rows  (per spec §3.14; 5 cos/4 growth/3 fin/2 crm/1 content)
 *   - decision_outcomes  :  3 rows  (Shore Capital worked / pivot pending / Theo unclear)
 *   - conversations      :  2 rows  (Apr 17 Clearview + Apr 27 manufacturing discovery)
 *
 * Post-insert backfills (this is the lineage closure step):
 *   - daily_briefs.payload.anomalies[].insightId   ← real insights.id (per §3.12)
 *   - daily_briefs.payload.opportunities[].insightId ← real insights.id (per §3.12)
 *   - notifications.ref_id (kind='insight_critical') ← real insights.id (per §3.17)
 *
 * Wave C (inbox) left anomalies/opportunities arrays empty and used synthetic
 * deterministic refIds for insight_critical notifications. This wave creates
 * the real insight rows then UPDATEs both surfaces to point at them.
 *
 * Depends on:
 *   - Pre-seed     : Mira Labs company row (metadata.persona='mira-labs-dogfood'),
 *                     3 agents (Maya/Theo/Iris).
 *   - Wave 1 (runs): heartbeat_runs UUIDs for insights.evidence.supporting_run_ids.
 *                     Looked up at runtime by (agent_id, date_window).
 *   - Wave 3 (inbox): approvals + daily_briefs + notifications already inserted.
 *                     approvals.json maps narrativeKey → approval UUID.
 *   - Wave 2 (issues): issues.json (informational; not strictly required here).
 *
 * Idempotency strategy:
 *   - company_memory : re-find by (companyId, title). Insert only if missing.
 *   - insights       : re-find by (companyId, title). Insert only if missing.
 *   - decision_outcomes: re-find by (approvalId). One per approval is the
 *                       service-layer invariant.
 *   - conversations  : re-find by (companyId, title).
 *   - daily_briefs backfill : UPDATE only when payload.anomalies / .opportunities
 *                       are still empty OR their insightId references don't
 *                       exist (idempotent in either direction).
 *   - notifications.ref_id backfill : UPDATE only when the current ref_id is
 *                       the deterministic synthetic from Wave C
 *                       (00000000-0000-0000-0000-<hash>) — the real insight
 *                       UUID is the v4 random shape so we can detect & rewire.
 *
 * Hard limits (council carries from main seed):
 *   - NEVER set companies.is_demo = true  (DB trigger 0109 rejects)
 *   - NEVER INSERT into instance_api_keys (council condition #4)
 *   - NEVER MODIFY pre-existing baseline rows outside the two explicit backfill
 *     surfaces (daily_briefs.payload + notifications.refId) per spec §3.12+§3.17
 *   - NO Stripe API calls; this script does not touch Stripe.
 *   - All embeddings (company_memory.embedding) left NULL.
 *   - All timestamps in the past (cap at RUN_NOW).
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-knowledge.ts
 */

import { sql, eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./client.js";
import {
  agents,
  companyMemory,
  conversations,
  dailyBriefs,
  decisionOutcomes,
  insights,
  notifications,
} from "./schema/index.js";
import type {
  DailyBriefAnomaly,
  DailyBriefOpportunity,
  DailyBriefPayload,
} from "./schema/daily_briefs.js";
import type { ExtractedInsight } from "./schema/conversations.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-knowledge] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-knowledge] DATABASE_URL is required");
  process.exit(1);
}

const PERSONA_TAG = "mira-labs-dogfood";

// ─── Time helpers ─────────────────────────────────────────────────────────────
const IST_OFFSET_MIN = 330;
const RUN_NOW = new Date("2026-05-13T08:30:00+05:30");

function ist(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(utc - IST_OFFSET_MIN * 60_000);
}

function clampToRunNow(d: Date): Date {
  return d.getTime() > RUN_NOW.getTime() ? RUN_NOW : d;
}

function istLocalDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ─── DB + lookups ─────────────────────────────────────────────────────────────
const db = createDb(DATABASE_URL);

console.log(
  "[seed-mira-labs-month1-knowledge] Looking up Mira Labs + agents…",
);

const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];
if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-knowledge] Mira Labs company not found. Run scripts/seed-mira-labs.ts first.",
  );
  process.exit(1);
}
const MIRA = companyRow.id;

const agentRows = await db
  .select({ id: agents.id, name: agents.name })
  .from(agents)
  .where(eq(agents.companyId, MIRA));
const findAgent = (name: string) => {
  const a = agentRows.find((r) => r.name === name);
  if (!a) throw new Error(`Agent not found: ${name}`);
  return a.id;
};
const MAYA = findAgent("Maya");
const THEO = findAgent("Theo");
const IRIS = findAgent("Iris");

console.log(
  `[seed-mira-labs-month1-knowledge] MIRA=${MIRA} MAYA=${MAYA} THEO=${THEO} IRIS=${IRIS}`,
);

// ─── Read approvals.json from Wave 3 (with DB fallback) ──────────────────────
// approvals.json is the canonical narrativeKey → uuid map written by Wave 3.
// When the file isn't on disk in this worktree (typical for parallel-wave
// workflows), fall back to the DB which is authoritative — Wave 3 stamped
// payload.narrativeKey on every approval it inserted.
type ApprovalsMap = Record<string, string>;
let approvalsMap: ApprovalsMap = {};
{
  // Try a few well-known locations on disk first.
  const candidatePaths: string[] = [];
  {
    let base = process.cwd();
    for (let hop = 0; hop < 6; hop++) {
      candidatePaths.push(
        `${base}/.planning/loop-2026-05-13-04/seeded-ids/approvals.json`,
      );
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
    // Also try the canonical main-checkout location.
    candidatePaths.push(
      "/Users/vinamr/Projects/founderos/.planning/loop-2026-05-13-04/seeded-ids/approvals.json",
    );
  }
  let approvalsPath: string | null = null;
  for (const c of candidatePaths) {
    if (existsSync(c)) {
      approvalsPath = c;
      break;
    }
  }
  if (approvalsPath) {
    try {
      approvalsMap = JSON.parse(
        readFileSync(approvalsPath, "utf8"),
      ) as ApprovalsMap;
      console.log(
        `[seed-mira-labs-month1-knowledge] Loaded ${Object.keys(approvalsMap).length} approval IDs from ${approvalsPath}`,
      );
    } catch (e) {
      console.warn(
        `[seed-mira-labs-month1-knowledge] Could not parse approvals.json: ${
          e instanceof Error ? e.message : String(e)
        } — falling back to DB.`,
      );
    }
  }

  if (Object.keys(approvalsMap).length === 0) {
    console.log(
      "[seed-mira-labs-month1-knowledge] approvals.json absent — querying DB for narrativeKey → uuid map.",
    );
    const dbRowsRaw = (await db.execute(
      sql`SELECT id, payload->>'narrativeKey' AS k FROM approvals
          WHERE company_id = ${MIRA}::uuid
            AND payload->>'persona' = ${PERSONA_TAG}
            AND payload->>'narrativeKey' IS NOT NULL`,
    )) as unknown as
      | Array<{ id: string; k: string | null }>
      | { rows: Array<{ id: string; k: string | null }> };
    const dbRows = Array.isArray(dbRowsRaw) ? dbRowsRaw : (dbRowsRaw.rows ?? []);
    for (const r of dbRows) {
      if (r.k) approvalsMap[r.k] = r.id;
    }
    console.log(
      `[seed-mira-labs-month1-knowledge] DB-resolved ${Object.keys(approvalsMap).length} narrativeKey → approval UUID mappings.`,
    );
  }
}

// ─── Heartbeat-run lookup helpers ─────────────────────────────────────────────
// For insights.evidence.supporting_run_ids we want a real heartbeat_run UUID
// from the right agent on the right narrative day. We query at runtime.

async function lookupRunsForAgentOnDate(
  agentId: string,
  dateIst: Date,
  limit = 3,
): Promise<string[]> {
  // Window: from start-of-IST-day to end-of-IST-day.
  const localDate = istLocalDate(dateIst); // 'YYYY-MM-DD' in Asia/Kolkata
  const [yyyy, mm, dd] = localDate.split("-").map((s) => Number.parseInt(s, 10));
  const dayStart = ist(yyyy!, mm!, dd!, 0, 0);
  const dayEnd = ist(yyyy!, mm!, dd!, 23, 59, 59);
  const raw = (await db.execute(
    sql`SELECT id FROM heartbeat_runs
        WHERE company_id = ${MIRA}::uuid
          AND agent_id = ${agentId}::uuid
          AND started_at >= ${dayStart.toISOString()}::timestamptz
          AND started_at <= ${dayEnd.toISOString()}::timestamptz
        ORDER BY started_at ASC
        LIMIT ${limit}`,
  )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
  const rows = Array.isArray(raw) ? raw : (raw.rows ?? []);
  return rows.map((r) => r.id);
}

// ─── company_memory plan (12 rows per spec §3.15) ─────────────────────────────
type MemoryPlan = {
  index: number;
  dayIdx: number; // 0-based from Apr 13
  kind: "weekly_summary" | "experiment_outcome" | "founder_note" | "milestone";
  category: "decision" | "pattern" | "context" | "outcome" | null;
  title: string;
  body: string;
  source: "auto" | "manual";
  pinned: boolean;
  occurredAtHourIst: number;
  occurredAtMinIst: number;
  topic?: string;
};

const memoryPlan: MemoryPlan[] = [
  {
    index: 1,
    dayIdx: 0,
    kind: "milestone",
    category: "context",
    title: "FounderOS adopted — 3 agents board configured",
    body:
      "Anita Mehra signed up for FounderOS after a Twitter rec from a YC friend. Maya (Chief of Staff, claude-opus-4-6), Theo (Growth & BD, gpt-4.1-mini) and Iris (Finance, claude-sonnet-4-6) are wired and active. Slack + Gmail OAuth landed on day one; Stripe follows tomorrow.",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 14,
    occurredAtMinIst: 0,
    topic: "onboarding",
  },
  {
    index: 2,
    dayIdx: 7,
    kind: "experiment_outcome",
    category: "pattern",
    title: "Theo proposal drafting: 4h → 8min (30x speedup)",
    body:
      "Shore Capital discovery call wrapped at 10:48 IST. Anita pasted the transcript into Theo and the proposal draft was ready in 8 minutes — historically that work took a full afternoon (~4h). Pattern recorded: proposal velocity is unlocked; bottleneck is now discovery-call count, not drafting capacity.",
    source: "auto",
    pinned: true,
    occurredAtHourIst: 11,
    occurredAtMinIst: 12,
    topic: "agent-leverage",
  },
  {
    index: 3,
    dayIdx: 8,
    kind: "weekly_summary",
    category: "outcome",
    title: "Week 1 wrap — 9 agent runs, 0 failures, MRR $5,200",
    body:
      "Setup week. Slack/Gmail/Stripe wired. Iris drafted 4 retainer summaries on the 15th; all approved in a 6-minute Inbox session. Maya morning briefs are sparse but coherent. No failed runs. Retainer base steady at $5,200 MRR.",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 17,
    occurredAtMinIst: 30,
    topic: "weekly-wrap",
  },
  {
    index: 4,
    dayIdx: 11,
    kind: "founder_note",
    category: "context",
    title: "OpenAI rate-limits start at 4 parallel runs — don't queue more",
    body:
      "Theo's third Verdant Foods draft failed at the OpenAI layer (HTTP 429, rate_limit_exceeded). Diagnosed: queueing more than 4 concurrent OpenAI runs hits the per-org limit on the cheap-tier key. Note for future prompt-template iterations: serialise Theo bursts above 4 calls, or split work across keys.",
    source: "manual",
    pinned: false,
    occurredAtHourIst: 16,
    occurredAtMinIst: 45,
    topic: "operations",
  },
  {
    index: 5,
    dayIdx: 15,
    kind: "weekly_summary",
    category: "outcome",
    title: "Week 2 wrap — 32 agent runs, 2 failures, Shore Capital signed",
    body:
      "Major week. Shore Capital signed at $1,000/mo (new MRR floor $6,400). Theo's proposal-velocity insight surfaced and acted on — Anita is booking 2x discovery calls into Week 3. Two failures (Theo OpenAI 429, one Iris Stripe timeout) both recovered on retry.",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 17,
    occurredAtMinIst: 30,
    topic: "weekly-wrap",
  },
  {
    index: 6,
    dayIdx: 17,
    kind: "milestone",
    category: "decision",
    title:
      "Pivoted wedge to professional services (legal/PE/insurance); killing manufacturing prospects",
    body:
      "After two discovery calls this week — one with a 200-staff manufacturing SaaS and one with a 30-person mid-market law firm cluster — Anita committed to professional services as the wedge (legal, PE, insurance). The Clearview Legal account already proves the legal motion works; the manufacturing one would be a fresh GTM with no warm references. Theo's prompt template is being updated to emphasise compliance/document-extraction. Verdant Foods (manufacturing) prospect is cancelled.",
    source: "manual",
    pinned: true,
    occurredAtHourIst: 14,
    occurredAtMinIst: 22,
    topic: "strategy",
  },
  {
    index: 7,
    dayIdx: 20,
    kind: "founder_note",
    category: "context",
    title: "3 weeks in. Theo + Iris feel like real co-workers.",
    body:
      "Stress reflection on Sunday afternoon. Three weeks into FounderOS and the agents are not novelties — they're co-workers. Maya's morning brief is the first thing I read. Theo drafts proposals while I'm in calls. Iris catches things I would miss. Still nervous about Bake House — the silence on the May retainer summary is a churn signal, not just a cashflow blip.",
    source: "manual",
    pinned: false,
    occurredAtHourIst: 19,
    occurredAtMinIst: 8,
    topic: "founder-reflection",
  },
  {
    index: 8,
    dayIdx: 22,
    kind: "weekly_summary",
    category: "outcome",
    title: "Week 3 wrap — pivot decision committed, Theo prompt swapped",
    body:
      "Pivot to professional services committed. Theo prompt template updated (compliance/document-extraction emphasis). Iris May-1 retainer summaries fired; Bake House revised once to add overdue-invoice line. Manufacturing prospects cancelled. 32 agent runs this week, 1 cancelled (the killed Verdant draft).",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 17,
    occurredAtMinIst: 30,
    topic: "weekly-wrap",
  },
  {
    index: 9,
    dayIdx: 23,
    kind: "experiment_outcome",
    category: "outcome",
    title:
      "Shore Capital signing — 14-day outcome: WORKED. Retainer running clean.",
    body:
      "14-day decision-outcome window closed. Shore Capital signed at full rate ($1,000/mo). Onboarding completed in 4 days vs the 7-day target. Retainer is running cleanly. Theo's proposal-draft pattern is validated end-to-end (transcript → 8-min draft → signed retainer in <14 days).",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 11,
    occurredAtMinIst: 30,
    topic: "outcome-tracking",
  },
  {
    index: 10,
    dayIdx: 25,
    kind: "milestone",
    category: "context",
    title: "Nasscom event — Acme Retail hot lead surfaced",
    body:
      "Met Acme Retail's COO at the Nasscom event. 50-person retail chain, Bangalore. Looking for AI customer-support automation. Ticket size ~$2K/mo + $3,500 setup. Captured into FounderOS as MIR-001; Theo drafting proposal that evening. First in-person-sourced lead since the pivot — confirms the pro-services wedge isn't blocking adjacent verticals.",
    source: "manual",
    pinned: false,
    occurredAtHourIst: 21,
    occurredAtMinIst: 14,
    topic: "pipeline",
  },
  {
    index: 11,
    dayIdx: 27,
    kind: "founder_note",
    category: "pattern",
    title: "Bake House comms drop-off → potential churn signal pattern",
    body:
      "Bake House has not responded to the May retainer summary (sent 6 days ago) nor to the $1,200 invoice (now 3 days overdue). Same shape as a churn signal I've seen at Google with the Workspace AI team — quiet customers are dropping, not just busy. Pattern to watch on future accounts: comms latency >7 days on a recurring retainer = warrant a phone call, not another email.",
    source: "manual",
    pinned: true,
    occurredAtHourIst: 9,
    occurredAtMinIst: 42,
    topic: "customer-risk",
  },
  {
    index: 12,
    dayIdx: 29,
    kind: "weekly_summary",
    category: "outcome",
    title:
      "Week 4 wrap — 4 retainers running, Acme proposal in flight, Bake House at-risk",
    body:
      "Four paying retainers ($6,400 MRR steady). Acme Retail proposal in review with the founder. SkyBridge cold outreach drafted and sent. Bake House silent on retainer summary + overdue invoice — flagged as at-risk; payment reminder sent Monday. 38 agent runs across the week, 1 retried failure.",
    source: "auto",
    pinned: false,
    occurredAtHourIst: 17,
    occurredAtMinIst: 30,
    topic: "weekly-wrap",
  },
];

// ─── insights plan (15 rows per spec §3.14) ───────────────────────────────────
type InsightPlan = {
  index: number;
  dayIdx: number;
  hourIst: number;
  minuteIst: number;
  department:
    | "chief-of-staff"
    | "growth"
    | "content"
    | "crm"
    | "finance";
  kind:
    | "kpi_anomaly"
    | "opportunity"
    | "blocker"
    | "experiment_suggestion"
    | "channel_recommendation"
    | "attribution";
  title: string;
  body: string;
  confidence: number;
  status: "open" | "acted_on" | "dismissed" | "expired";
  recommendation: string | null;
  /** Which agent's runs feed evidence.supporting_run_ids. */
  supportingAgent: "maya" | "theo" | "iris" | null;
  /** Narrative key used by Wave C's notifications.refId synth lookup. */
  notificationKey?:
    | "bake-house-overdue-blocker"
    | "theo-openai-spike-apr24"
    | "pivot-pro-services"
    | "spend-under-budget";
};

const insightPlan: InsightPlan[] = [
  // Day 4 (Apr 17) — Slack #pipeline channel underused (week 1) — dismissed
  {
    index: 1,
    dayIdx: 4,
    hourIst: 7,
    minuteIst: 36,
    department: "chief-of-staff",
    kind: "opportunity",
    title: "Slack #pipeline channel underused — only 2 agent posts in week 1",
    body: "Maya posted 2 standups + 0 prospect-updates to #pipeline. Either the channel isn't routing right or it's overkill for a solo founder. Recommend dropping if same pattern in week 2.",
    confidence: 0.4,
    status: "dismissed",
    recommendation: "Archive #pipeline if usage stays below 5 posts/week.",
    supportingAgent: "maya",
  },
  // Day 5 (Apr 18) — Add Saturday Maya brief — dismissed
  {
    index: 2,
    dayIdx: 5,
    hourIst: 9,
    minuteIst: 18,
    department: "chief-of-staff",
    kind: "opportunity",
    title: "Add Saturday Maya brief — Anita reads Sundays",
    body: "Inbox-open events from the dogfood UI show Anita opens the brief on Sunday morning ~70% of the time. Saturday brief would surface weekend-prep items earlier.",
    confidence: 0.35,
    status: "dismissed",
    recommendation: "Enable Saturday Maya cron on a 1-week trial.",
    supportingAgent: "maya",
  },
  // Day 8 (Apr 21) — Proposal velocity opportunity — acted_on
  {
    index: 3,
    dayIdx: 8,
    hourIst: 11,
    minuteIst: 24,
    department: "growth",
    kind: "opportunity",
    title:
      "Proposal velocity unlocked — pipeline now bottlenecked by discovery-call count",
    body:
      "Theo drafted the Shore Capital proposal in 8 min (historical: ~4h). At this rate, proposal-drafting capacity is no longer the constraint. Recommendation: book 2x more discovery calls in May.",
    confidence: 0.82,
    status: "acted_on",
    recommendation:
      "Block 2 discovery-call slots/week. Target 5 new prospects in May.",
    supportingAgent: "theo",
  },
  // Day 10 (Apr 23) — Clearview Legal scope expansion — acted_on
  {
    index: 4,
    dayIdx: 10,
    hourIst: 10,
    minuteIst: 8,
    department: "crm",
    kind: "channel_recommendation",
    title:
      "Clearview Legal scope-expansion opening — propose Q3 add-on",
    body:
      "Priya Iyer mentioned a contract-clause backlog on the April scope call. Account has runway for a $500/mo add-on. Recommend Theo drafts the Q3 add-on proposal.",
    confidence: 0.7,
    status: "acted_on",
    recommendation:
      "Theo: draft Q3 add-on proposal for Clearview Legal ($500/mo, contract-clause extraction).",
    supportingAgent: "theo",
  },
  // Day 11 (Apr 24) — Theo OpenAI spike — acted_on (Notification ref)
  {
    index: 5,
    dayIdx: 11,
    hourIst: 7,
    minuteIst: 38,
    department: "finance",
    kind: "kpi_anomaly",
    title: "Theo OpenAI spend spike +180% on Apr 24",
    body:
      "Theo invoked 12 proposal-drafting jobs in a 4h window. Daily Theo spend hit $1.20 vs the ~$0.30 baseline (+180% MoM normalised). Three runs failed at the API layer (rate_limit_exceeded). Recommendation: cap concurrent OpenAI runs at 4.",
    confidence: 0.91,
    status: "acted_on",
    recommendation:
      "Add a serial-queue gate on Theo when >4 jobs are pending. Document in operations memory.",
    supportingAgent: "theo",
    notificationKey: "theo-openai-spike-apr24",
  },
  // Day 13 (Apr 26) — Cold-outreach to dental groups (expired)
  {
    index: 6,
    dayIdx: 13,
    hourIst: 10,
    minuteIst: 4,
    department: "growth",
    kind: "experiment_suggestion",
    title: "Cold-outreach to dental groups via Northwood Dental ref",
    body:
      "Northwood Dental has been a clean retainer for 3 months. Other Bangalore dental groups in the same WhatsApp circle could be warm intros. Recommend Theo drafts 5 personalised outreach emails.",
    confidence: 0.3,
    status: "expired",
    recommendation: null,
    supportingAgent: "theo",
  },
  // Day 14 (Apr 27) — Manufacturing prospect conflict — acted_on
  {
    index: 7,
    dayIdx: 14,
    hourIst: 18,
    minuteIst: 32,
    department: "chief-of-staff",
    kind: "opportunity",
    title:
      "Manufacturing prospect surfaced; conflict with current pro-services positioning",
    body:
      "200-staff manufacturing SaaS discovery call ran long. Real budget, real pain, but vertical mismatch against our 4 existing clients (1 legal, 1 PE, 1 dental, 1 bakery). Surfacing the wedge decision: pursue or pass?",
    confidence: 0.75,
    status: "acted_on",
    recommendation:
      "Maya: synthesise both wedges + run pros/cons in tomorrow's brief.",
    supportingAgent: "maya",
  },
  // Day 16 (Apr 29) — Pivot recommendation — acted_on (Notification ref)
  {
    index: 8,
    dayIdx: 16,
    hourIst: 18,
    minuteIst: 24,
    department: "chief-of-staff",
    kind: "experiment_suggestion",
    title:
      "Test pro-services-only positioning in May outreach (vs current generalist)",
    body:
      "Maya synthesised both wedges + the 4-customer base. Pro-services (legal/PE/insurance) has 3/4 customers as proof-points + warmer referral graph. Manufacturing is a fresh GTM. Recommend committing the wedge in week 3.",
    confidence: 0.7,
    status: "acted_on",
    recommendation:
      "Commit pro-services wedge. Update Theo's prompt. Cancel Verdant Foods.",
    supportingAgent: "maya",
    notificationKey: "pivot-pro-services",
  },
  // Day 7 (Apr 20) — '4h → 8min' LinkedIn post (content)
  {
    index: 9,
    dayIdx: 7,
    hourIst: 12,
    minuteIst: 4,
    department: "content",
    kind: "experiment_suggestion",
    title: "Publish '4h → 8min' proposal-velocity LinkedIn post",
    body:
      "The Shore Capital proposal-drafting win is a quotable founder-mode anecdote. LinkedIn post structured around the time delta would land with the IST PM/founder audience Anita is building toward.",
    confidence: 0.55,
    status: "open",
    recommendation:
      "Draft a 3-paragraph LinkedIn post; ship before end of week 3.",
    supportingAgent: "theo",
  },
  // Day 19 (May 1) — Theo prompt drift blocker — acted_on
  {
    index: 10,
    dayIdx: 19,
    hourIst: 16,
    minuteIst: 12,
    department: "chief-of-staff",
    kind: "blocker",
    title: "Theo prompt drift — pre-pivot drafts are now off-brand",
    body:
      "Three drafts in the queue still reference generalist-SMB positioning. Prompt template was swapped on Apr 30 — Theo needs to regenerate any pending pro-services drafts or they ship off-brand.",
    confidence: 0.8,
    status: "acted_on",
    recommendation:
      "Re-run pending drafts under the new prompt; archive the generalist drafts.",
    supportingAgent: "theo",
  },
  // Day 21 (May 3) — Northwood→SkyBridge referral channel — acted_on
  {
    index: 11,
    dayIdx: 21,
    hourIst: 14,
    minuteIst: 28,
    department: "crm",
    kind: "channel_recommendation",
    title:
      "Northwood Dental → SkyBridge referral hit; replicate ask for warm intros",
    body:
      "SkyBridge Insurance came in as a warm intro from Northwood Dental. First referral conversion to a discovery call. Recommend: ask the other 3 retainers for 1 named warm-intro each.",
    confidence: 0.65,
    status: "acted_on",
    recommendation:
      "Send 3 founder-mode warm-intro asks (Clearview, Bake House, Shore Capital).",
    supportingAgent: "maya",
  },
  // Day 22 (May 4) — Cumulative agent spend under budget — acted_on (Notification ref)
  {
    index: 12,
    dayIdx: 22,
    hourIst: 17,
    minuteIst: 14,
    department: "finance",
    kind: "kpi_anomaly",
    title: "Cumulative agent spend Apr = $63 — 60% under budget",
    body:
      "Iris Friday digest: cumulative agent API spend through April is $63 vs $158/mo combined budget cap. Runway impact: +2 weeks vs plan. Suggests budget caps are conservative or Maya/Theo/Iris are throttling.",
    confidence: 0.92,
    status: "acted_on",
    recommendation:
      "Raise Maya budget to $200/mo to unlock longer-context briefs.",
    supportingAgent: "iris",
    notificationKey: "spend-under-budget",
  },
  // Day 24 (May 6) — Bake House retention attribution — open
  // (Reframed from finance/kpi_anomaly → growth/attribution so the overall
  // department distribution hits the 5 cos / 4 growth / 3 finance / 2 crm /
  // 1 content split required by spec §3.14. The same Bake-House thread is
  // also surfaced as a finance/blocker on Day 27 — this row carries the
  // retention-pattern angle, the Day 27 row carries the operational blocker.)
  {
    index: 13,
    dayIdx: 24,
    hourIst: 8,
    minuteIst: 12,
    department: "growth",
    kind: "attribution",
    title:
      "Bake House 2nd late-pay event in 6mo — retention pattern emerging",
    body:
      "Stripe webhook flagged the May invoice 5 days overdue. Bake House was also 8d overdue on the Feb invoice. Two late-pay events on the only food-vertical customer; non-retention attribution suggests vertical-fit risk for the bakery wedge. Flag for retention conversation, not just cashflow chase.",
    confidence: 0.95,
    status: "open",
    recommendation:
      "Schedule a 15-min retention call with Jason (Ops) this week. Tag the food-vertical wedge as 'at-risk' until resolved.",
    supportingAgent: "iris",
  },
  // Day 25 (May 8) — Nasscom event attribution — open
  {
    index: 14,
    dayIdx: 25,
    hourIst: 20,
    minuteIst: 48,
    department: "growth",
    kind: "attribution",
    title: "Nasscom event drove 1 hot lead (Acme); confirm channel ROI",
    body:
      "One in-person event in May delivered Acme Retail (~$2K/mo + $3,500 setup potential). Cost basis: 1 evening + $0 ticket. Channel ROI is strong if it repeats; one data-point isn't enough yet.",
    confidence: 0.6,
    status: "open",
    recommendation:
      "Book 1 more relevant event in June; track lead → discovery-call conversion.",
    supportingAgent: "theo",
  },
  // Day 27 (May 10) — Bake House overdue blocker — open (Notification ref)
  {
    index: 15,
    dayIdx: 27,
    hourIst: 8,
    minuteIst: 12,
    department: "finance",
    kind: "blocker",
    title:
      "Bake House $1,200 invoice 3 days overdue; possible at-risk customer",
    body:
      "Iris flagged: Bake House May invoice 3 days overdue + no response to retainer summary (sent 6 days ago). Two-signal compound — pattern matches a quiet-churn shape, not a cashflow blip.",
    confidence: 0.88,
    status: "open",
    recommendation:
      "Send payment reminder + scope conversation; phone call if no reply in 48h.",
    supportingAgent: "iris",
    notificationKey: "bake-house-overdue-blocker",
  },
];

// Validate the exact spec distribution before we touch the DB.
{
  const deptCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  for (const i of insightPlan) {
    deptCounts[i.department] = (deptCounts[i.department] ?? 0) + 1;
    statusCounts[i.status] = (statusCounts[i.status] ?? 0) + 1;
  }
  if (insightPlan.length !== 15) {
    throw new Error(`insightPlan must have 15 rows, got ${insightPlan.length}`);
  }
  const expectDept = {
    "chief-of-staff": 5,
    growth: 4,
    finance: 3,
    crm: 2,
    content: 1,
  };
  for (const [k, v] of Object.entries(expectDept)) {
    if (deptCounts[k] !== v) {
      throw new Error(
        `insightPlan department mismatch on ${k}: expected ${v}, got ${deptCounts[k] ?? 0}`,
      );
    }
  }
  const expectStatus = { acted_on: 8, open: 4, dismissed: 2, expired: 1 };
  for (const [k, v] of Object.entries(expectStatus)) {
    if (statusCounts[k] !== v) {
      throw new Error(
        `insightPlan status mismatch on ${k}: expected ${v}, got ${statusCounts[k] ?? 0}`,
      );
    }
  }
  if (memoryPlan.length !== 12) {
    throw new Error(`memoryPlan must have 12 rows, got ${memoryPlan.length}`);
  }
}

// ─── Date helper ──────────────────────────────────────────────────────────────
function dayIstAt(
  dayIdx: number,
  hourIst: number,
  minuteIst: number,
): Date {
  // Day 0 = Apr 13 2026 IST.
  const baseUtc = ist(2026, 4, 13, hourIst, minuteIst);
  return new Date(baseUtc.getTime() + dayIdx * 86_400_000);
}

// ─── Conversations plan (2 rows per spec §3.28) ───────────────────────────────
type ConversationPlan = {
  dayIdx: number;
  hourIst: number;
  minuteIst: number;
  title: string;
  participants: string[];
  sourceKind: "transcript_paste";
  transcript: string;
  extractedInsights: ExtractedInsight[];
};

const conversationPlan: ConversationPlan[] = [
  {
    dayIdx: 4,
    hourIst: 16,
    minuteIst: 12,
    title: "Clearview Legal — scope-expansion call (Apr 17)",
    participants: ["Anita Mehra (Founder)", "Priya Iyer (Partner, Clearview Legal)"],
    sourceKind: "transcript_paste",
    transcript:
      "Priya: We've got a backlog of about 80 contracts a month going through clause-by-clause review. The current $2,400/mo extraction agent is saving us hours — could it also flag risk language vs our internal redline policy?\n" +
      "Anita: That's a different shape — risk classification on top of extraction. Yes, doable. Probably another $500/mo for Q3 if you want it as an add-on.\n" +
      "Priya: Bring me a proposal. I'd want it live by July.\n" +
      "Anita: I'll have Theo draft it this week. One question — do you have a redline policy document I can reference?\n" +
      "Priya: Yes, I'll forward the PDF. It's a 40-page playbook.\n" +
      "Anita: Perfect. We'll calibrate the model against it.",
    extractedInsights: [
      {
        title: "Clearview Q3 add-on opportunity confirmed",
        content:
          "Priya explicitly asked for a proposal on risk-classification add-on at ~$500/mo, live by July. Conversion looks high — she initiated.",
        confidence: 0.85,
        source_quote: "Bring me a proposal. I'd want it live by July.",
      },
      {
        title: "Redline-policy PDF is the calibration input",
        content:
          "Clearview will share their 40-page internal redline playbook. Theo's draft should reference it as the calibration source, not as generic legal-AI marketing copy.",
        confidence: 0.75,
        source_quote: "It's a 40-page playbook.",
      },
      {
        title: "Volume signal — 80 contracts/month",
        content:
          "Backlog volume (80 contracts/month) is useful for sizing the Q3 add-on retainer. Probably justifies tiered pricing rather than flat $500/mo.",
        confidence: 0.6,
        source_quote: "We've got a backlog of about 80 contracts a month",
      },
    ],
  },
  {
    dayIdx: 14,
    hourIst: 11,
    minuteIst: 30,
    title: "Manufacturing-floor SaaS — discovery call (Apr 27)",
    participants: [
      "Anita Mehra (Founder)",
      "Rakesh K. (COO, manufacturing SaaS prospect)",
    ],
    sourceKind: "transcript_paste",
    transcript:
      "Rakesh: We have 200 staff across two factories — Pune and Hyderabad. Quality-control paperwork is killing us. Three full-time clerks just transcribing tablet entries into the ERP.\n" +
      "Anita: That's a clear automation target. The kind of agent we'd build would sit between the tablet entry layer and your ERP API. 4-week audit + 3-month build, then a $2-3K/mo support retainer.\n" +
      "Rakesh: Budget is fine. The harder question is integration — our ERP is a heavily-customised SAP fork from 2018. No public API.\n" +
      "Anita: That's a real risk. We'd have to build a custom adapter — probably triples the implementation cost.\n" +
      "Rakesh: We can pay for it. What I need is confidence you can ship.\n" +
      "Anita: Honest answer — manufacturing-floor + bespoke SAP is outside our reference set today. Our 4 customers are dental, bakery, legal, PE. Let me think on whether we're the right fit and come back this week.\n" +
      "Rakesh: Fair. Talk soon.",
    extractedInsights: [
      {
        title: "Real budget + real pain, but vertical mismatch",
        content:
          "Prospect has clear automation pain (3 FTE clerks transcribing) and budget. But manufacturing-floor + custom SAP fork is outside the proof-point set (4 customers, all knowledge-work verticals).",
        confidence: 0.9,
        source_quote: "manufacturing-floor + bespoke SAP is outside our reference set today",
      },
      {
        title: "Custom adapter cost is the hidden risk",
        content:
          "2018 SAP fork with no public API means a custom adapter build — triples implementation cost and adds delivery risk. Wedge decision must factor this in.",
        confidence: 0.8,
        source_quote:
          "Our ERP is a heavily-customised SAP fork from 2018. No public API.",
      },
      {
        title: "Wedge fork — pursue manufacturing or go pro-services?",
        content:
          "This call surfaces the strategic fork: pursue manufacturing (one big customer, big GTM risk) vs double down on pro-services (legal/PE/insurance with warmer referral graph). Maya should synthesise this against the other discovery call this week.",
        confidence: 0.85,
        source_quote: "Let me think on whether we're the right fit",
      },
    ],
  },
];

// ─── Summary counters ─────────────────────────────────────────────────────────
const summary = {
  companyMemory: 0,
  insights: 0,
  decisionOutcomes: 0,
  conversations: 0,
  dailyBriefBackfills: 0,
  notificationBackfills: 0,
};

// ─── Transaction body ─────────────────────────────────────────────────────────
await db.transaction(async (tx) => {
  // 1. COMPANY_MEMORY — 12 rows. Idempotent re-find by (companyId, title).
  console.log("[seed-mira-labs-month1-knowledge] company_memory (12)…");

  for (const m of memoryPlan) {
    const occurredAt = clampToRunNow(
      dayIstAt(m.dayIdx, m.occurredAtHourIst, m.occurredAtMinIst),
    );
    const existing = (await tx.execute(
      sql`SELECT id FROM company_memory
          WHERE company_id = ${MIRA}::uuid AND title = ${m.title}
          LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) continue;

    await tx.insert(companyMemory).values({
      companyId: MIRA,
      kind: m.kind,
      title: m.title,
      body: m.body,
      topic: m.topic ?? null,
      occurredAt,
      pinned: m.pinned,
      source: m.source,
      category: m.category,
      embedding: null,
      expiresAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    summary.companyMemory++;
  }

  // Re-query the row map for cross-table linkage (decision_outcomes.memoryEntryId).
  const memoryRowsRaw = (await tx.execute(
    sql`SELECT id, title FROM company_memory WHERE company_id = ${MIRA}::uuid`,
  )) as unknown as
    | Array<{ id: string; title: string }>
    | { rows: Array<{ id: string; title: string }> };
  const memoryRows = Array.isArray(memoryRowsRaw)
    ? memoryRowsRaw
    : (memoryRowsRaw.rows ?? []);
  const memoryIdByTitle = new Map<string, string>(
    memoryRows.map((r) => [r.title, r.id]),
  );

  // 2. INSIGHTS — 15 rows. Idempotent re-find by (companyId, title).
  console.log("[seed-mira-labs-month1-knowledge] insights (15)…");

  // Track {notificationKey → insightId} for the notification backfill below.
  const insightIdByNotificationKey = new Map<string, string>();
  // Also track {insightTitle → insightId, day, status} for daily_brief backfill.
  type InsightCacheEntry = {
    id: string;
    title: string;
    dayIdx: number;
    department: InsightPlan["department"];
    kind: InsightPlan["kind"];
    status: InsightPlan["status"];
  };
  const insightCache: InsightCacheEntry[] = [];

  for (const i of insightPlan) {
    const createdAt = clampToRunNow(
      dayIstAt(i.dayIdx, i.hourIst, i.minuteIst),
    );

    // Build evidence with real heartbeat_run UUIDs when supporting agent set.
    let supportingRunIds: string[] = [];
    if (i.supportingAgent) {
      const agentId =
        i.supportingAgent === "maya"
          ? MAYA
          : i.supportingAgent === "theo"
            ? THEO
            : IRIS;
      const dateAnchor = dayIstAt(i.dayIdx, i.hourIst, i.minuteIst);
      // Reach back up to 2 days for evidence in case the agent didn't run on the
      // exact narrative day (e.g. weekend insight referencing Friday's runs).
      supportingRunIds = await lookupRunsForAgentOnDate(agentId, dateAnchor, 2);
      if (supportingRunIds.length === 0) {
        const earlier = new Date(dateAnchor.getTime() - 86_400_000);
        supportingRunIds = await lookupRunsForAgentOnDate(agentId, earlier, 2);
      }
    }

    const evidence =
      supportingRunIds.length > 0
        ? { supporting_run_ids: supportingRunIds }
        : {};

    // Idempotent re-find by (companyId, title). Reuse existing row if found.
    let insightId: string;
    const existing = (await tx.execute(
      sql`SELECT id FROM insights
          WHERE company_id = ${MIRA}::uuid AND title = ${i.title}
          LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) {
      insightId = existingArr[0]!.id;
    } else {
      const inserted = await tx
        .insert(insights)
        .values({
          companyId: MIRA,
          department: i.department,
          kind: i.kind,
          title: i.title,
          body: i.body,
          confidence: i.confidence,
          recommendation: i.recommendation,
          evidence,
          status: i.status,
          outcomeNote: null,
          expiresAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: insights.id });
      insightId = inserted[0]!.id;
      summary.insights++;
    }

    if (i.notificationKey) {
      insightIdByNotificationKey.set(i.notificationKey, insightId);
    }
    insightCache.push({
      id: insightId,
      title: i.title,
      dayIdx: i.dayIdx,
      department: i.department,
      kind: i.kind,
      status: i.status,
    });
  }

  // 3. DECISION_OUTCOMES — 3 rows. Idempotent re-find by approvalId.
  console.log("[seed-mira-labs-month1-knowledge] decision_outcomes (3)…");

  type DecisionPlan = {
    key: string;
    approvalKey: string;
    outcomeStatus: "worked" | "pending_followup" | "unclear";
    promptedAt: Date;
    answeredAt: Date | null;
    founderNote: string | null;
    metricDelta: string | null;
    memoryTitle: string | null;
  };

  const decisionPlan: DecisionPlan[] = [
    {
      key: "shore-capital-signing",
      // Day 10 approval (Apr 22 Shore Capital welcome retainer), 14d follow-up
      // lands on Day 24 (May 6).
      approvalKey: "w2-theo-apr20-shore-capital-proposal-draft",
      outcomeStatus: "worked",
      promptedAt: clampToRunNow(ist(2026, 5, 6, 11, 0)),
      answeredAt: clampToRunNow(ist(2026, 5, 6, 11, 30)),
      founderNote:
        "Signed at full rate. Retainer running cleanly. Onboarding took 4 days vs target 7.",
      metricDelta: "+$1,000/mo MRR; onboarded in 4 days",
      memoryTitle:
        "Shore Capital signing — 14-day outcome: WORKED. Retainer running clean.",
    },
    {
      key: "pivot-decision",
      // Day 18 prompt-swap approval; 14d cron lands May 14 (after RUN_NOW),
      // so the row is in pending_followup state with promptedAt set ~May 2.
      approvalKey: "w3-maya-apr30-theo-prompt-swap-confirmation",
      outcomeStatus: "pending_followup",
      promptedAt: clampToRunNow(ist(2026, 5, 2, 9, 0)),
      answeredAt: null,
      founderNote: null,
      metricDelta: null,
      memoryTitle: null,
    },
    {
      key: "theo-prompt-update",
      // Day 18 approval (prompt swap), Day 25 (May 8) early outcome
      // — only 2 drafts emitted so unclear is the right status.
      approvalKey: "w3-maya-apr30-theo-prompt-swap-confirmation",
      outcomeStatus: "unclear",
      promptedAt: clampToRunNow(ist(2026, 5, 8, 14, 0)),
      answeredAt: clampToRunNow(ist(2026, 5, 8, 14, 22)),
      founderNote:
        "Still early; new prompt has only generated 2 drafts. Will re-evaluate end of week 5.",
      metricDelta: null,
      memoryTitle: null,
    },
  ];

  for (const d of decisionPlan) {
    const approvalId = approvalsMap[d.approvalKey];
    if (!approvalId) {
      console.warn(
        `[seed-mira-labs-month1-knowledge] decision_outcomes: approval not found for key=${d.approvalKey} — skipping ${d.key}`,
      );
      continue;
    }
    const memoryEntryId = d.memoryTitle
      ? (memoryIdByTitle.get(d.memoryTitle) ?? null)
      : null;

    // Idempotency: pivot-decision and theo-prompt-update share the same
    // approvalKey but represent two distinct outcome cycles (the cron prompt
    // and a manual founder-stamped outcome). The cron path enforces "at most
    // one row per approval" but the seed needs both rows to demo the UI lane.
    // Disambiguate idempotently by (approvalId, outcomeStatus).
    const existing = (await tx.execute(
      sql`SELECT id FROM decision_outcomes
          WHERE approval_id = ${approvalId}::uuid
            AND outcome_status = ${d.outcomeStatus}
          LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) continue;

    await tx.insert(decisionOutcomes).values({
      approvalId,
      companyId: MIRA,
      outcomeStatus: d.outcomeStatus,
      promptedAt: d.promptedAt,
      answeredAt: d.answeredAt,
      founderNote: d.founderNote,
      metricDelta: d.metricDelta,
      memoryEntryId,
      createdAt: d.promptedAt,
      updatedAt: d.answeredAt ?? d.promptedAt,
    });
    summary.decisionOutcomes++;
  }

  // 4. CONVERSATIONS — 2 rows.
  console.log("[seed-mira-labs-month1-knowledge] conversations (2)…");

  for (const c of conversationPlan) {
    const createdAt = clampToRunNow(
      dayIstAt(c.dayIdx, c.hourIst, c.minuteIst),
    );
    const completedAt = clampToRunNow(
      new Date(createdAt.getTime() + 2 * 60_000),
    );
    const existing = (await tx.execute(
      sql`SELECT id FROM conversations
          WHERE company_id = ${MIRA}::uuid AND title = ${c.title}
          LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) continue;

    await tx.insert(conversations).values({
      companyId: MIRA,
      title: c.title,
      participants: c.participants,
      sourceKind: c.sourceKind,
      transcript: c.transcript,
      extractionStatus: "complete",
      extractedInsights: c.extractedInsights,
      createdAt,
      completedAt,
    });
    summary.conversations++;
  }

  // 5. DAILY_BRIEFS BACKFILL — populate payload.anomalies[].insightId and
  //    payload.opportunities[].insightId with real insight UUIDs.
  //
  //    Coherence rule (spec §3.12): anomalies + opportunities arrays MUST
  //    reference real insights rows. Wave C left them empty. We resolve by
  //    matching insights whose narrative day falls on (or near) the brief's
  //    for_date and whose kind/status fit the surface:
  //      - anomaly surface  ← insights.kind = 'kpi_anomaly' OR 'blocker'
  //      - opportunity surface ← insights.kind = 'opportunity' OR
  //                                              'experiment_suggestion' OR
  //                                              'channel_recommendation' OR
  //                                              'attribution'
  //    Status filter: 'open' OR 'acted_on' (per spec — dismissed/expired don't
  //    belong on a daily brief).
  console.log("[seed-mira-labs-month1-knowledge] daily_briefs backfill…");

  type BriefRow = { id: string; for_date: string; payload: DailyBriefPayload };
  const briefRowsRaw = (await tx.execute(
    sql`SELECT id, for_date::text AS for_date, payload
        FROM daily_briefs
        WHERE company_id = ${MIRA}::uuid
        ORDER BY for_date ASC`,
  )) as unknown as Array<BriefRow> | { rows: Array<BriefRow> };
  const briefRows = Array.isArray(briefRowsRaw)
    ? briefRowsRaw
    : (briefRowsRaw.rows ?? []);

  // Pre-index insights by dayIdx for fast lookup.
  const ANOMALY_KINDS = new Set(["kpi_anomaly", "blocker"]);
  const OPPORTUNITY_KINDS = new Set([
    "opportunity",
    "experiment_suggestion",
    "channel_recommendation",
    "attribution",
  ]);
  const surfaceableInsights = insightCache.filter(
    (i) => i.status === "open" || i.status === "acted_on",
  );

  // dayIdx → Date helper
  function dayIdxToIsoLocal(dayIdx: number): string {
    return istLocalDate(dayIstAt(dayIdx, 12, 0));
  }
  const dayIdxToIso = new Map<number, string>();
  for (let i = 0; i <= 30; i++) dayIdxToIso.set(i, dayIdxToIsoLocal(i));
  const isoToDayIdx = new Map<string, number>();
  for (const [k, v] of dayIdxToIso.entries()) isoToDayIdx.set(v, k);

  for (const brief of briefRows) {
    const dayIdx = isoToDayIdx.get(brief.for_date);
    if (dayIdx === undefined) continue; // brief outside the seeded window

    // Find insights whose dayIdx is exactly today OR yesterday (a brief on day N
    // can surface anomalies first observed on day N-1).
    const candidates = surfaceableInsights.filter(
      (i) => i.dayIdx === dayIdx || i.dayIdx === dayIdx - 1,
    );
    if (candidates.length === 0) continue;

    const newAnomalies: DailyBriefAnomaly[] = candidates
      .filter((i) => ANOMALY_KINDS.has(i.kind))
      .slice(0, 3)
      .map((i) => ({ title: i.title, insightId: i.id }));

    const newOpportunities: DailyBriefOpportunity[] = candidates
      .filter((i) => OPPORTUNITY_KINDS.has(i.kind))
      .slice(0, 3)
      .map((i) => ({
        title: i.title,
        expectedImpact: "See insight detail",
        insightId: i.id,
      }));

    const existingPayload = brief.payload ?? ({} as DailyBriefPayload);
    const existingAnomalies = (existingPayload.anomalies ?? []) as
      | DailyBriefAnomaly[]
      | Array<string | DailyBriefAnomaly>;
    const existingOpps = (existingPayload.opportunities ?? []) as
      | DailyBriefOpportunity[]
      | Array<string | DailyBriefOpportunity>;

    // Determine whether the slot is already well-populated. The Wave 3 payload
    // shape used `string[]` for anomalies/opportunities (free-text headlines)
    // — those don't carry insightId and need rewiring. Detect any element
    // that's a string OR an object missing `insightId`.
    function isWellFormed(arr: Array<unknown>): boolean {
      if (arr.length === 0) return false;
      return arr.every(
        (el) =>
          typeof el === "object" &&
          el !== null &&
          typeof (el as { insightId?: unknown }).insightId === "string",
      );
    }
    const anomaliesWellFormed = isWellFormed(existingAnomalies);
    const opportunitiesWellFormed = isWellFormed(existingOpps);

    // Compose the merged payload. If a surface is already well-formed AND has
    // entries, leave it alone. Otherwise replace with the resolved entries.
    const mergedPayload: DailyBriefPayload = {
      headline: existingPayload.headline ?? "",
      kpiMovements: existingPayload.kpiMovements ?? [],
      anomalies:
        anomaliesWellFormed && (existingAnomalies as DailyBriefAnomaly[]).length > 0
          ? (existingAnomalies as DailyBriefAnomaly[])
          : newAnomalies,
      blockers: existingPayload.blockers ?? [],
      opportunities:
        opportunitiesWellFormed &&
        (existingOpps as DailyBriefOpportunity[]).length > 0
          ? (existingOpps as DailyBriefOpportunity[])
          : newOpportunities,
      topThreeActions: existingPayload.topThreeActions ?? [],
    };

    // Only UPDATE if something actually changed.
    const anomaliesChanged =
      JSON.stringify(mergedPayload.anomalies) !==
      JSON.stringify(existingPayload.anomalies ?? []);
    const opportunitiesChanged =
      JSON.stringify(mergedPayload.opportunities) !==
      JSON.stringify(existingPayload.opportunities ?? []);
    if (!anomaliesChanged && !opportunitiesChanged) continue;
    if (newAnomalies.length === 0 && newOpportunities.length === 0) continue;

    await tx
      .update(dailyBriefs)
      .set({ payload: mergedPayload })
      .where(eq(dailyBriefs.id, brief.id));
    summary.dailyBriefBackfills++;
  }

  // 6. NOTIFICATIONS BACKFILL — rewire kind='insight_critical' ref_id from
  //    Wave C's synthetic deterministic UUIDs to real insight UUIDs.
  //
  //    Wave C used synthInsightId(narrativeKey) → '00000000-0000-0000-0000-<hex>'.
  //    Real insight UUIDs from Drizzle's defaultRandom() are v4 — they never
  //    start with '00000000-0000-0000-0000-'. We match by title so the
  //    backfill is idempotent in both directions.
  console.log(
    "[seed-mira-labs-month1-knowledge] notifications backfill (insight_critical)…",
  );

  // Wave C's title → insightKey → real-insightId mapping (see seed-mira-labs-month1-inbox.ts)
  const notifTitleToInsightKey: Record<string, string> = {
    "Bake House $1,200 invoice 3d overdue": "bake-house-overdue-blocker",
    "Theo OpenAI spend spike +180% on Apr 24": "theo-openai-spike-apr24",
    "Pivot recommendation — pro-services wedge": "pivot-pro-services",
    "Cumulative agent spend $8.20 — 60% under budget": "spend-under-budget",
  };

  const notifRowsRaw = (await tx.execute(
    sql`SELECT id, title, ref_id FROM notifications
        WHERE company_id = ${MIRA}::uuid AND kind = 'insight_critical'`,
  )) as unknown as
    | Array<{ id: string; title: string; ref_id: string | null }>
    | { rows: Array<{ id: string; title: string; ref_id: string | null }> };
  const notifRows = Array.isArray(notifRowsRaw)
    ? notifRowsRaw
    : (notifRowsRaw.rows ?? []);

  for (const n of notifRows) {
    const insightKey = notifTitleToInsightKey[n.title];
    if (!insightKey) continue;
    const insightId = insightIdByNotificationKey.get(insightKey);
    if (!insightId) continue;
    // Skip if already pointing at the real insight (idempotent re-run).
    if (n.ref_id === insightId) continue;

    await tx
      .update(notifications)
      .set({ refId: insightId })
      .where(eq(notifications.id, n.id));
    summary.notificationBackfills++;
  }
});

// ─── End-of-run summary ───────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-knowledge] Inserted:
  company_memory     : ${summary.companyMemory}
  insights           : ${summary.insights}
  decision_outcomes  : ${summary.decisionOutcomes}
  conversations      : ${summary.conversations}

[seed-mira-labs-month1-knowledge] Backfilled:
  daily_briefs (anomalies / opportunities) : ${summary.dailyBriefBackfills}
  notifications (insight_critical ref_id)  : ${summary.notificationBackfills}
`);

process.exit(0);
