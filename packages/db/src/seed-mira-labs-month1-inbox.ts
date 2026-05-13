/**
 * seed-mira-labs-month1-inbox.ts — Wave 3 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent C):
 *   - approvals          : 25 new rows (22 approved + 2 revision→approved + 1 rejected)
 *   - approval_comments  : ~15 rows (on revision-requested approvals + a few approved)
 *   - issue_approvals    : ~20 link rows wiring approvals to MIR-NNN issues
 *   - daily_briefs       : 29 NEW rows (Apr 13 → May 12; today's is pre-seeded)
 *   - weekly_wraps       : 4 rows (Friday 17:00 IST week endings)
 *   - notifications      : 20 rows (10 approval_needed + 4 critical + 3 wrap + 3 integration)
 *   - inbox_state        : 30 rows (5 unread approvals + 15 read + 5 issue + 3 archived + 2 snoozed)
 *
 * Depends on:
 *   - Wave 1 (runs)   : approvals.requestedByAgentId resolves to a real heartbeat agent.
 *                       Approval payloads carry `persona` so we can re-find them.
 *   - Wave 2 (issues) : issue_approvals links approvals to issues by MIR-NNN. We read
 *                       .planning/loop-2026-05-13-04/seeded-ids/issues.json at startup.
 *   - Pre-seed        : Mira Labs company row (metadata.persona='mira-labs-dogfood'),
 *                       3 agents (Maya/Theo/Iris), 5 pre-existing pending approvals,
 *                       1 pre-existing daily_brief for today (forDate=2026-05-13 IST).
 *
 * Hard limits (council carry-over):
 *   - NEVER set companies.is_demo = true  (DB trigger 0109 rejects)
 *   - NEVER INSERT into instance_api_keys (council condition #4)
 *   - NEVER touch the 5 pre-seeded pending approvals or today's daily_brief
 *   - All approval payloads tag `payload.persona = 'mira-labs-dogfood'` for re-find
 *   - All gmailDraftId values use the `draft_placeholder_<NNN>` sentinel (server
 *     execution guard rejects them before any Composio call). Counter starts at 005
 *     because pre-seed uses 001..004.
 *   - All timestamps in the past (cap at RUN_NOW)
 *
 * Idempotency strategy:
 *   - approvals: re-find by (companyId, payload->>'persona'='mira-labs-dogfood',
 *     payload->>'narrativeKey'=<unique key>). If found, skip insert.
 *   - approval_comments: re-find by (approvalId, body).
 *   - issue_approvals: primary key (issueId, approvalId) — use onConflictDoNothing.
 *   - daily_briefs: UNIQUE (companyId, forDate) — onConflictDoNothing.
 *   - weekly_wraps: UNIQUE (companyId, weekEndingAt) — onConflictDoNothing.
 *   - notifications: dedupe partial UNIQUE on unread rows — for already-read rows
 *     we re-find by (companyId, userId, kind, refKind, refId, title).
 *   - inbox_state: UNIQUE (userId, entityType, entityId) — onConflictDoNothing.
 *
 * Output: .planning/loop-2026-05-13-04/seeded-ids/approvals.json mapping
 * narrative key → approval UUID for Wave D's decision_outcomes lookups.
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-inbox.ts
 */

import { sql, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./client.js";
import {
  agents,
  approvalComments,
  approvals,
  dailyBriefs,
  inboxState,
  issueApprovals,
  notifications,
  weeklyWraps,
} from "./schema/index.js";
import type { DailyBriefPayload } from "./schema/daily_briefs.js";
import type {
  WeeklyWrapHighlight,
  WeeklyWrapMetrics,
} from "./schema/weekly_wraps.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-inbox] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-inbox] DATABASE_URL is required");
  process.exit(1);
}

const PERSONA_TAG = "mira-labs-dogfood";
const ANITA_AUTH_UID = "9b29fdf9-2ddb-4919-8fd2-77e4640849c9";

// ─── Time helpers ─────────────────────────────────────────────────────────────
const IST_OFFSET_MIN = 330;
const RUN_NOW = new Date("2026-05-13T08:30:00+05:30");
const DAY_MS = 86_400_000;

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

function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
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

console.log("[seed-mira-labs-month1-inbox] Looking up Mira Labs + agents…");

const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];
if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-inbox] Mira Labs company not found. Run scripts/seed-mira-labs.ts first.",
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
  `[seed-mira-labs-month1-inbox] MIRA=${MIRA} MAYA=${MAYA} THEO=${THEO} IRIS=${IRIS}`,
);

// ─── Read issues.json from Wave 2 ─────────────────────────────────────────────
type IssuesMap = Record<string, string>;
let issuesMap: IssuesMap = {};
{
  // Walk up cwd to find .planning/loop-2026-05-13-04/seeded-ids/issues.json
  let base = process.cwd();
  let issuesPath: string | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const candidate = `${base}/.planning/loop-2026-05-13-04/seeded-ids/issues.json`;
    if (existsSync(candidate)) {
      issuesPath = candidate;
      break;
    }
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }
  if (issuesPath) {
    try {
      issuesMap = JSON.parse(readFileSync(issuesPath, "utf8")) as IssuesMap;
      console.log(
        `[seed-mira-labs-month1-inbox] Loaded ${Object.keys(issuesMap).length} issue IDs from ${issuesPath}`,
      );
    } catch (e) {
      console.warn(
        `[seed-mira-labs-month1-inbox] Could not parse issues.json: ${e instanceof Error ? e.message : String(e)}. issue_approvals will be skipped.`,
      );
    }
  } else {
    console.warn(
      "[seed-mira-labs-month1-inbox] issues.json not found — issue_approvals links will be skipped. Run Wave 2 first.",
    );
  }
}

// ─── Approvals plan ───────────────────────────────────────────────────────────
// We define 25 narrative approvals across the 30-day window. Each row carries
// payload.persona='mira-labs-dogfood' + payload.narrativeKey=<unique> so re-runs
// can idempotently re-find them by JSON-path lookup.
//
// Status mix per spec §3.6:
//   - 22 approved
//   -  2 revision_requested → approved (Day 19 Bake House + Day 30 Acme)
//      Each "revision" produces TWO rows: first revision_requested, second approved.
//   -  1 rejected (Day 24 cold-outreach to friend)
//
// gmailDraftId counter starts at 005 (pre-seed used 001..004).

type ApprovalPlan = {
  narrativeKey: string; // unique anchor for idempotency + Wave D lookup
  createdAt: Date;
  decidedAt?: Date; // optional for revision-requested (when first decided)
  status: "approved" | "rejected" | "revision_requested";
  agent: "maya" | "theo" | "iris";
  action: string;
  summary: string;
  clientName?: string; // for issue_approvals linking + payload color
  gmailDraftIdx?: number; // 1-based offset into [5,6,7,...]; if set, payload includes gmailDraftId
  decisionNote: string | null;
  // For the revision-pair: linkPriorKey points at the prior row in the SAME pair,
  // so we can record "this approval supersedes <prior>" in payload.
  linkedPriorKey?: string;
  rejected?: boolean; // marker for the rejected one (status='rejected')
  // Day index (0=Apr13) for time placement
  dayIdx: number;
  // Hour-of-day IST for createdAt randomization
  istHour: number;
  istMinute: number;
};

const plan: ApprovalPlan[] = [];

// Helper: create a date Apr-13 + dayIdx + hh:mm IST
function dayTime(dayIdx: number, hour: number, minute: number): Date {
  const base = ist(2026, 4, 13, 0, 0);
  return new Date(base.getTime() + dayIdx * DAY_MS + (hour * 60 + minute) * 60_000);
}

// ── Week 1 (Apr 13-19 → days 0-6): 4 approvals (Iris Apr 15 retainer summaries)
// MIR-008 Clearview Legal, MIR-009 Bake House, MIR-010 Northwood Dental
// (4 summaries — Shore Capital signed later, so this is dental/bakehouse/legal + Iris's portfolio)
plan.push(
  {
    narrativeKey: "w1-iris-apr15-clearview-legal-retainer",
    dayIdx: 2, // Apr 15
    istHour: 9,
    istMinute: 24,
    createdAt: dayTime(2, 9, 24),
    decidedAt: dayTime(2, 20, 36),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Clearview Legal",
    summary: "Send April retainer summary to Clearview Legal",
    gmailDraftIdx: 1,
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w1-iris-apr15-bake-house-retainer",
    dayIdx: 2,
    istHour: 9,
    istMinute: 32,
    createdAt: dayTime(2, 9, 32),
    decidedAt: dayTime(2, 20, 41),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Bake House",
    summary: "Send April retainer summary to Bake House",
    gmailDraftIdx: 2,
    decisionNote: "Approved — small edit to the opening line, already applied in the draft.",
  },
  {
    narrativeKey: "w1-iris-apr15-northwood-dental-retainer",
    dayIdx: 2,
    istHour: 9,
    istMinute: 40,
    createdAt: dayTime(2, 9, 40),
    decidedAt: dayTime(2, 20, 44),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Northwood Dental",
    summary: "Send April retainer summary to Northwood Dental",
    gmailDraftIdx: 3,
    decisionNote: "Approved. Iris caught the missing line about June availability — nice.",
  },
  {
    narrativeKey: "w1-theo-apr17-clearview-scope-reply",
    dayIdx: 4, // Apr 17 Fri
    istHour: 14,
    istMinute: 12,
    createdAt: dayTime(4, 14, 12),
    decidedAt: dayTime(4, 15, 5),
    status: "approved",
    agent: "theo",
    action: "send_reply",
    clientName: "Clearview Legal",
    summary: "Reply to Clearview Legal scope-expansion email",
    gmailDraftIdx: 4,
    decisionNote: "Approved as-is.",
  },
);

// ── Week 2 (Apr 20-26 → days 7-13): 7 approvals
// Day 8 (Apr 20): Theo Shore Capital proposal
// Day 9 (Apr 21): Theo Shore Capital follow-up (send proposal action)
// Day 10 (Apr 22): Iris Shore Capital welcome retainer onboarding
// Maya 4 cold drafts (slack standup posts etc.)
plan.push(
  {
    narrativeKey: "w2-theo-apr20-shore-capital-proposal-draft",
    dayIdx: 7,
    istHour: 11,
    istMinute: 24,
    createdAt: dayTime(7, 11, 24),
    decidedAt: dayTime(7, 11, 37),
    status: "approved",
    agent: "theo",
    action: "send_proposal",
    clientName: "Shore Capital",
    summary: "Send Shore Capital proposal — $1,000/mo + $2,500 setup",
    gmailDraftIdx: 5,
    decisionNote: "Approved. Don't send for 30 min, want to call Rahul first.",
  },
  {
    narrativeKey: "w2-theo-apr21-shore-capital-follow-up",
    dayIdx: 8,
    istHour: 10,
    istMinute: 6,
    createdAt: dayTime(8, 10, 6),
    decidedAt: dayTime(8, 10, 19),
    status: "approved",
    agent: "theo",
    action: "send_follow_up",
    clientName: "Shore Capital",
    summary: "Follow-up email — Shore Capital pricing confirmation",
    gmailDraftIdx: 6,
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w2-iris-apr22-shore-capital-welcome-retainer",
    dayIdx: 9,
    istHour: 16,
    istMinute: 18,
    createdAt: dayTime(9, 16, 18),
    decidedAt: dayTime(9, 16, 28),
    status: "approved",
    agent: "iris",
    action: "send_welcome_retainer",
    clientName: "Shore Capital",
    summary: "Welcome retainer-onboarding email to Shore Capital",
    gmailDraftIdx: 7,
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w2-maya-apr20-slack-standup",
    dayIdx: 7,
    istHour: 7,
    istMinute: 36,
    createdAt: dayTime(7, 7, 36),
    decidedAt: dayTime(7, 7, 49),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Daily standup post to #mira-team — Shore Capital proposal day",
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w2-maya-apr21-slack-standup",
    dayIdx: 8,
    istHour: 7,
    istMinute: 32,
    createdAt: dayTime(8, 7, 32),
    decidedAt: dayTime(8, 7, 45),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Daily standup post — Shore Capital proposal sent",
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w2-maya-apr22-slack-standup",
    dayIdx: 9,
    istHour: 7,
    istMinute: 41,
    createdAt: dayTime(9, 7, 41),
    decidedAt: dayTime(9, 7, 52),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Daily standup post — Shore Capital signing confirmation",
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w2-maya-apr24-finance-digest-post",
    dayIdx: 11,
    istHour: 17,
    istMinute: 14,
    createdAt: dayTime(11, 17, 14),
    decidedAt: dayTime(11, 17, 22),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Friday finance digest to #mira-finance — Week 2 wrap",
    decisionNote: "Approved as-is.",
  },
);

// ── Week 3 (Apr 27 - May 3 → days 14-20): 6 approvals
// Day 17: Maya pivot recommendation approval (decision capture)
// Day 18 (Apr 30): agent_config revision (Theo prompt swap)
// Day 19 (May 1): Iris monthly summaries × 4 (Northwood, Bake House [REVISION], Clearview, Shore Capital)
//   - Bake House: TWO rows (revision_requested → approved 5h later)
// Day 21 (May 3): Theo SkyBridge first cold pitch (queued, approved Day 22)
//
// Total: pivot-approval (1) + Theo prompt-swap approval (1) + Iris × 4 (Northwood, Bake House [2 rows!], Clearview, Shore Capital)
// = 1 + 1 + 4 + 1 (BH 2nd) + 1 SkyBridge (Day 22) — too many. Spec says 6 in week 3,
// and 4 in week 4. The Bake House pair counts as 2 rows. So week-3:
//   1. Day 17 Maya "post pivot decision to #mira-team" (approved)
//   2. Day 18 Maya "approve Theo prompt swap action" (approved)
//   3. Day 19 Iris Clearview May summary (approved)
//   4. Day 19 Iris Northwood May summary (approved)
//   5. Day 19 Iris Bake House May summary — REVISION REQUESTED (1st row)
//   6. Day 19 Iris Bake House May summary — APPROVED with revision (2nd row, +5h)
// = 6 ✓
//   + Day 19 Iris Shore Capital first-month summary → drop to week 4 SkyBridge bucket
plan.push(
  {
    narrativeKey: "w3-maya-apr29-pivot-slack-announcement",
    dayIdx: 16, // Apr 29
    istHour: 19,
    istMinute: 12,
    createdAt: dayTime(16, 19, 12),
    decidedAt: dayTime(16, 19, 28),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Post pivot decision summary to #mira-team",
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w3-maya-apr30-theo-prompt-swap-confirmation",
    dayIdx: 17, // Apr 30
    istHour: 14,
    istMinute: 18,
    createdAt: dayTime(17, 14, 18),
    decidedAt: dayTime(17, 14, 24),
    status: "approved",
    agent: "maya",
    action: "agent_config_revise",
    summary: "Apply Theo prompt update — pro-services positioning",
    decisionNote: "Approved. Already discussed in Day 18 founder note.",
  },
  {
    narrativeKey: "w3-iris-may1-clearview-legal-may-retainer",
    dayIdx: 18,
    istHour: 9,
    istMinute: 8,
    createdAt: dayTime(18, 9, 8),
    decidedAt: dayTime(18, 19, 32),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Clearview Legal",
    summary: "Send May retainer summary to Clearview Legal",
    gmailDraftIdx: 8,
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w3-iris-may1-northwood-dental-may-retainer",
    dayIdx: 18,
    istHour: 9,
    istMinute: 16,
    createdAt: dayTime(18, 9, 16),
    decidedAt: dayTime(18, 19, 34),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Northwood Dental",
    summary: "Send May retainer summary to Northwood Dental",
    gmailDraftIdx: 9,
    decisionNote: "Approved as-is.",
  },
  // BAKE HOUSE REVISION PAIR — first row, status='revision_requested'
  {
    narrativeKey: "w3-iris-may1-bake-house-may-retainer-revision-requested",
    dayIdx: 18,
    istHour: 9,
    istMinute: 24,
    createdAt: dayTime(18, 9, 24),
    decidedAt: dayTime(18, 14, 6),
    status: "revision_requested",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Bake House",
    summary: "Send May retainer summary to Bake House",
    gmailDraftIdx: 10,
    decisionNote: "Add a line about the overdue payment in the same email — I want to know if there's a problem before I just chase it.",
  },
  // BAKE HOUSE — second row ~5h later, status='approved'
  {
    narrativeKey: "w3-iris-may1-bake-house-may-retainer-approved",
    dayIdx: 18,
    istHour: 19,
    istMinute: 12,
    createdAt: dayTime(18, 19, 12),
    decidedAt: dayTime(18, 19, 28),
    status: "approved",
    agent: "iris",
    action: "send_retainer_summary",
    clientName: "Bake House",
    summary: "Send revised May retainer summary to Bake House (with payment ask)",
    gmailDraftIdx: 11,
    decisionNote: "Approved with revision applied — tone is friendly, references the reorder script we shipped in March.",
    linkedPriorKey: "w3-iris-may1-bake-house-may-retainer-revision-requested",
  },
);

// ── Week 4 (May 4 - May 10 → days 21-27): 4 approvals
// Day 22 (May 4): Theo SkyBridge Insurance cold pitch
// Day 24 (May 6): REJECTED cold-outreach to friend (Theo drafted, Anita rejected)
// Day 26 (May 8): Maya brief approval (Friday digest post)
// Day 27 (May 9): Iris Shore Capital first month welcome retainer-summary (May 1 was monthly,
//                 first-month summary is Day 27 since they signed Day 10)
plan.push(
  {
    narrativeKey: "w4-theo-may4-skybridge-cold-pitch",
    dayIdx: 21,
    istHour: 11,
    istMinute: 36,
    createdAt: dayTime(21, 11, 36),
    decidedAt: dayTime(21, 12, 6),
    status: "approved",
    agent: "theo",
    action: "send_cold_email",
    clientName: "SkyBridge Insurance",
    summary: "Send SkyBridge Insurance opening cold pitch — pro-services angle",
    gmailDraftIdx: 12,
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w4-theo-may6-rejected-friend-cold-email",
    dayIdx: 23,
    istHour: 16,
    istMinute: 18,
    createdAt: dayTime(23, 16, 18),
    decidedAt: dayTime(23, 16, 26),
    status: "approved", // overridden to 'rejected' below via rejected flag — see iter
    rejected: true,
    agent: "theo",
    action: "send_cold_email",
    clientName: "Verdant Foods",
    summary: "Send cold outreach to friend's company — Verdant Foods CTO",
    gmailDraftIdx: 13,
    decisionNote: "Too aggressive. Let me write this one myself.",
  },
  {
    narrativeKey: "w4-maya-may8-friday-digest",
    dayIdx: 25,
    istHour: 17,
    istMinute: 18,
    createdAt: dayTime(25, 17, 18),
    decidedAt: dayTime(25, 17, 28),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Friday digest to #mira-finance — Week 4 wrap with Nasscom hot lead",
    decisionNote: "Approved as-is.",
  },
  {
    narrativeKey: "w4-iris-may9-shore-capital-first-month-summary",
    dayIdx: 26,
    istHour: 14,
    istMinute: 24,
    createdAt: dayTime(26, 14, 24),
    decidedAt: dayTime(26, 14, 38),
    status: "approved",
    agent: "iris",
    action: "send_welcome_retainer",
    clientName: "Shore Capital",
    summary: "Shore Capital first-month retainer summary",
    gmailDraftIdx: 14,
    decisionNote: "Approved as-is. Onboarding running clean.",
  },
);

// ── Week 5 (May 11 - May 12 → days 28-29): 4 approvals (the 5 pre-seeded pending are
// for TODAY May 13). Per spec: "Week 5: 4 + the 5 pre-seeded pending" so we emit 4
// historical approvals on May 11/12.
// Day 30 (May 12): Acme Retail proposal REVISION pair (Theo drafted, Anita revised x2, finally approved)
// Day 29 (May 11): Maya morning brief approve / Theo Fielding prep email approve
plan.push(
  {
    narrativeKey: "w5-theo-may11-fielding-prep-email",
    dayIdx: 28,
    istHour: 10,
    istMinute: 36,
    createdAt: dayTime(28, 10, 36),
    decidedAt: dayTime(28, 11, 4),
    status: "approved",
    agent: "theo",
    action: "send_reply",
    clientName: "Fielding Logistics",
    summary: "Send Fielding Logistics discovery-call prep email",
    gmailDraftIdx: 15,
    decisionNote: "Approved as-is. Friendly tone, asks for the right docs.",
  },
  {
    narrativeKey: "w5-maya-may11-brief-approval",
    dayIdx: 28,
    istHour: 7,
    istMinute: 41,
    createdAt: dayTime(28, 7, 41),
    decidedAt: dayTime(28, 7, 52),
    status: "approved",
    agent: "maya",
    action: "post_slack_message",
    summary: "Monday standup post — Fielding call tomorrow",
    decisionNote: "Approved as-is.",
  },
  // ACME REVISION PAIR — first row, revision_requested
  {
    narrativeKey: "w5-theo-may12-acme-retail-proposal-revision-requested",
    dayIdx: 29,
    istHour: 11,
    istMinute: 24,
    createdAt: dayTime(29, 11, 24),
    decidedAt: dayTime(29, 17, 6),
    status: "revision_requested",
    agent: "theo",
    action: "send_proposal",
    clientName: "Acme Retail",
    summary: "Send Acme Retail proposal — first draft",
    gmailDraftIdx: 16,
    decisionNote: "Trim the opening to 2 sentences, lead with the support-triage outcome not the audit pitch.",
  },
  // ACME — second row, approved (~5h later)
  {
    narrativeKey: "w5-theo-may12-acme-retail-proposal-approved",
    dayIdx: 29,
    istHour: 22,
    istMinute: 8,
    createdAt: dayTime(29, 22, 8),
    decidedAt: dayTime(29, 22, 24),
    status: "approved",
    agent: "theo",
    action: "send_proposal",
    clientName: "Acme Retail",
    summary: "Send Acme Retail proposal — revised with tighter opening",
    gmailDraftIdx: 17,
    decisionNote: "Approved with revision applied. Lead with outcome, not process.",
    linkedPriorKey: "w5-theo-may12-acme-retail-proposal-revision-requested",
  },
);

// Sanity: must be exactly 25
if (plan.length !== 25) {
  throw new Error(
    `[seed-mira-labs-month1-inbox] Plan must be exactly 25 approvals; got ${plan.length}`,
  );
}

// ─── Daily briefs plan ────────────────────────────────────────────────────────
// 29 NEW rows (Apr 13 → May 12 inclusive). Today's (May 13) is pre-seeded.
// MRR sequence per spec §3.12: $5,200 initial → $6,400 by Day 12.

type BriefPlanEntry = {
  dayIdx: number; // 0..28 (Apr 13..May 12)
  forDateISO: string; // "2026-04-13"
  generatedAt: Date;
  emailSentAt: Date | null;
  payload: DailyBriefPayload;
};

const briefPlan: BriefPlanEntry[] = [];

function mrrForDay(dayIdx: number): { from: string; to: string; delta: string; commentary: string } {
  // Days 0-10 → $5,200 → $5,200 (no movement)
  // Days 11-12 → ramps to $6,400 (Shore Capital signs+activates Day 10-11)
  // Days 12-28 → $6,400 stable
  if (dayIdx < 9) {
    return {
      metric: "MRR",
      from: "$5,200",
      to: "$5,200",
      delta: "$0",
      commentary: "Steady — 3 retainer clients running.",
    } as any;
  }
  if (dayIdx === 9 || dayIdx === 10) {
    return {
      metric: "MRR",
      from: "$5,200",
      to: "$5,200",
      delta: "$0",
      commentary: "Shore Capital proposal sent; signing window open.",
    } as any;
  }
  if (dayIdx === 11) {
    return {
      metric: "MRR",
      from: "$5,200",
      to: "$6,400",
      delta: "+$1,200",
      commentary: "Shore Capital signed at $1,000/mo + $200 setup amortised; new MRR floor.",
    } as any;
  }
  return {
    metric: "MRR",
    from: "$6,400",
    to: "$6,400",
    delta: "$0",
    commentary: "4 retainers stable — Bake House at risk, watch closely.",
  } as any;
}

// Helper to find approval UUID later (after insert) for topThreeActions.
// We resolve UUIDs after inserting approvals; for now we use narrativeKey
// placeholders that get rewritten in a post-insert pass.
type PendingAction = {
  action: string;
  rationale: string;
  approvalKey?: string; // narrative key → resolved to approvalId after insert
};

type BriefDraft = {
  dayIdx: number;
  generatedHour: number; // IST
  generatedMin: number; // IST
  emailSent: boolean;
  headline: string;
  kpi: ReturnType<typeof mrrForDay>;
  pendingActions: PendingAction[];
  blockers: Array<{ title: string; resolutionAction: string }>;
  opportunities: string[];
  anomalies: string[];
};

function dayDate(dayIdx: number): { iso: string; localDate: Date } {
  const local = ist(2026, 4, 13, 0, 0);
  const target = new Date(local.getTime() + dayIdx * DAY_MS);
  return { iso: istLocalDate(target), localDate: target };
}

const briefDrafts: BriefDraft[] = [];

// Days 0-2 (Apr 13-15) — sparse
briefDrafts.push(
  {
    dayIdx: 0,
    generatedHour: 7,
    generatedMin: 18,
    emailSent: true,
    headline: "Day 1 — agents initialised; sample brief.",
    kpi: mrrForDay(0),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 1,
    generatedHour: 7,
    generatedMin: 24,
    emailSent: true,
    headline: "Day 2 — Stripe connected; first invoice scan tonight.",
    kpi: mrrForDay(1),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 2,
    generatedHour: 7,
    generatedMin: 32,
    emailSent: true,
    headline: "Iris flagged 4 retainer summaries for review (15th-of-month).",
    kpi: mrrForDay(2),
    pendingActions: [
      {
        action: "Review Iris-drafted retainer summaries",
        rationale: "Four April-month summaries queued (Clearview, Bake House, Northwood, internal Mira). Each takes ~90s to skim.",
        approvalKey: "w1-iris-apr15-clearview-legal-retainer",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
);

// Days 3-13 (Apr 16-26) — normal cadence
briefDrafts.push(
  {
    dayIdx: 3,
    generatedHour: 7,
    generatedMin: 14,
    emailSent: true,
    headline: "Retainer summaries approved; Theo first proposal cycle starting.",
    kpi: mrrForDay(3),
    pendingActions: [
      { action: "Read Clearview Legal scope-expansion email", rationale: "Customer-driven scope question — 24h response window." },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 4,
    generatedHour: 7,
    generatedMin: 26,
    emailSent: true,
    headline: "Theo drafted Clearview Legal scope reply.",
    kpi: mrrForDay(4),
    pendingActions: [
      {
        action: "Approve Clearview Legal scope-expansion reply",
        rationale: "Theo drafted in 12 min. Pricing $2,400/mo base + $500 add-on Q3.",
        approvalKey: "w1-theo-apr17-clearview-scope-reply",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 5,
    generatedHour: 7,
    generatedMin: 38,
    emailSent: false,
    headline: "Saturday — light brief.",
    kpi: mrrForDay(5),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 6,
    generatedHour: 7,
    generatedMin: 12,
    emailSent: false,
    headline: "Sunday — no agent runs; rest day.",
    kpi: mrrForDay(6),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 7,
    generatedHour: 7,
    generatedMin: 20,
    emailSent: true,
    headline: "Shore Capital discovery call this morning; Theo standing by.",
    kpi: mrrForDay(7),
    pendingActions: [
      { action: "Run Shore Capital discovery call (11:00 IST)", rationale: "Boutique PE; pitch investment-memo formatter retainer." },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 8,
    generatedHour: 7,
    generatedMin: 32,
    emailSent: true,
    headline: "Shore Capital proposal sent (Theo drafted in 8 min).",
    kpi: mrrForDay(8),
    pendingActions: [
      {
        action: "Approve Shore Capital follow-up email",
        rationale: "Pricing confirmation. Rahul asked for the audit scope details.",
        approvalKey: "w2-theo-apr21-shore-capital-follow-up",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 9,
    generatedHour: 7,
    generatedMin: 41,
    emailSent: true,
    headline: "Shore Capital signed — fourth retainer client. $6,400 MRR.",
    kpi: mrrForDay(9),
    pendingActions: [
      {
        action: "Approve Iris welcome retainer-onboarding for Shore Capital",
        rationale: "First-week kickoff email auto-drafted.",
        approvalKey: "w2-iris-apr22-shore-capital-welcome-retainer",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 10,
    generatedHour: 7,
    generatedMin: 16,
    emailSent: true,
    headline: "Week 2 momentum — 1 new retainer, agents stable.",
    kpi: mrrForDay(10),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 11,
    generatedHour: 7,
    generatedMin: 22,
    emailSent: true,
    headline: "Verdant Foods proposal hit OpenAI rate-limit; retry succeeded.",
    kpi: mrrForDay(11),
    pendingActions: [],
    blockers: [
      { title: "Theo rate-limited on parallel runs >4", resolutionAction: "Throttle Theo concurrency to 3; document in agent config." },
    ],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 12,
    generatedHour: 7,
    generatedMin: 30,
    emailSent: false,
    headline: "Saturday — Friday digest delivered.",
    kpi: mrrForDay(12),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 13,
    generatedHour: 7,
    generatedMin: 12,
    emailSent: false,
    headline: "Sunday — quiet.",
    kpi: mrrForDay(13),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
);

// Days 14-20 (Apr 27 - May 3) — pivot tone
briefDrafts.push(
  {
    dayIdx: 14,
    generatedHour: 7,
    generatedMin: 18,
    emailSent: true,
    headline: "Pivot decision pending; 2 discovery calls this week.",
    kpi: mrrForDay(14),
    pendingActions: [
      { action: "Discovery call — manufacturing prospect (15:00 IST)", rationale: "Stress-test the manufacturing wedge." },
    ],
    blockers: [],
    opportunities: ["Manufacturing-vs-pro-services positioning decision pending — Maya synthesising tomorrow."],
    anomalies: [],
  },
  {
    dayIdx: 15,
    generatedHour: 7,
    generatedMin: 24,
    emailSent: true,
    headline: "Mid-market law firm cluster call today; both wedges on the table.",
    kpi: mrrForDay(15),
    pendingActions: [
      { action: "Discovery call — law firm cluster (16:30 IST)", rationale: "Stronger warm-reference angle than manufacturing." },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 16,
    generatedHour: 7,
    generatedMin: 32,
    emailSent: true,
    headline: "Maya recommends pro-services wedge; pivot capture pending.",
    kpi: mrrForDay(16),
    pendingActions: [
      {
        action: "Confirm pivot to pro-services + post to #mira-team",
        rationale: "Maya synthesised both calls + current customers; recommendation is professional services.",
        approvalKey: "w3-maya-apr29-pivot-slack-announcement",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 17,
    generatedHour: 7,
    generatedMin: 40,
    emailSent: true,
    headline: "Pivot committed — Theo prompt updated; manufacturing prospects cancelled.",
    kpi: mrrForDay(17),
    pendingActions: [
      {
        action: "Approve Theo prompt swap (pro-services positioning)",
        rationale: "Replace generalist template with pro-services compliance angle.",
        approvalKey: "w3-maya-apr30-theo-prompt-swap-confirmation",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 18,
    generatedHour: 7,
    generatedMin: 12,
    emailSent: true,
    headline: "May 1 — Iris drafting 4 retainer summaries (1st-of-month cron).",
    kpi: mrrForDay(18),
    pendingActions: [
      {
        action: "Review Bake House May retainer summary",
        rationale: "Bake House is 6d overdue on April invoice — add the payment ask.",
        approvalKey: "w3-iris-may1-bake-house-may-retainer-revision-requested",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 19,
    generatedHour: 7,
    generatedMin: 38,
    emailSent: false,
    headline: "Saturday — quiet; weekly wrap drafted.",
    kpi: mrrForDay(19),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 20,
    generatedHour: 7,
    generatedMin: 14,
    emailSent: false,
    headline: "Sunday founder note — 3 weeks in; Theo + Iris feel like co-workers.",
    kpi: mrrForDay(20),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
);

// Days 21-28 (May 4 - May 11) — momentum tone
briefDrafts.push(
  {
    dayIdx: 21,
    generatedHour: 7,
    generatedMin: 18,
    emailSent: true,
    headline: "4 retainers running clean; Theo drafting SkyBridge cold pitch.",
    kpi: mrrForDay(21),
    pendingActions: [
      {
        action: "Approve SkyBridge Insurance cold pitch",
        rationale: "First post-pivot outreach; pro-services angle.",
        approvalKey: "w4-theo-may4-skybridge-cold-pitch",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 22,
    generatedHour: 7,
    generatedMin: 24,
    emailSent: true,
    headline: "Bake House silence on retainer summary — flagging.",
    kpi: mrrForDay(22),
    pendingActions: [
      { action: "Decide on Bake House chase strategy", rationale: "May invoice due May 7; no reply to retainer summary." },
    ],
    blockers: [
      { title: "Bake House non-response 5 days", resolutionAction: "Maya will draft a payment-reminder + scope conversation prompt." },
    ],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 23,
    generatedHour: 7,
    generatedMin: 32,
    emailSent: true,
    headline: "Shore Capital signing — 14-day outcome: WORKED. Retainer running clean.",
    kpi: mrrForDay(23),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 24,
    generatedHour: 7,
    generatedMin: 16,
    emailSent: true,
    headline: "Bake House invoice now due; Iris's 15th run is 8d away — Maya will flag.",
    kpi: mrrForDay(24),
    pendingActions: [],
    blockers: [
      { title: "Bake House $1,200 invoice falls due today", resolutionAction: "Stripe webhook ingested; manual reminder needed before scheduled run." },
    ],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 25,
    generatedHour: 7,
    generatedMin: 26,
    emailSent: true,
    headline: "Nasscom event — Acme Retail hot lead surfaced.",
    kpi: mrrForDay(25),
    pendingActions: [
      { action: "Draft Acme Retail proposal", rationale: "Theo briefing-prepped from your Nasscom notes." },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 26,
    generatedHour: 7,
    generatedMin: 30,
    emailSent: false,
    headline: "Saturday — Acme proposal review.",
    kpi: mrrForDay(26),
    pendingActions: [],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 27,
    generatedHour: 7,
    generatedMin: 12,
    emailSent: false,
    headline: "Sunday — Bake House at-risk insight surfaced.",
    kpi: mrrForDay(27),
    pendingActions: [],
    blockers: [
      { title: "Bake House 3-day overdue + 2nd time in 6 months", resolutionAction: "Approve payment reminder; consider scope conversation if no response by May 14." },
    ],
    opportunities: [],
    anomalies: [],
  },
  {
    dayIdx: 28,
    generatedHour: 7,
    generatedMin: 18,
    emailSent: true,
    headline: "Payment reminder approved; Bake House still silent. Acme proposal finalising.",
    kpi: mrrForDay(28),
    pendingActions: [
      {
        action: "Approve Fielding Logistics prep email",
        rationale: "Discovery call tomorrow.",
        approvalKey: "w5-theo-may11-fielding-prep-email",
      },
    ],
    blockers: [],
    opportunities: [],
    anomalies: [],
  },
);

// Day 29 (May 12) is intentionally omitted — today's pre-seeded brief covers
// the May 13 "Day 30" cliffhanger from May 12's reflection forward. Total briefs:
// 29 new (Apr 13 day 0 → May 11 day 28) + 1 pre-seeded (May 13 day 30) = 30.
// Spec range "Apr 13 → May 12 inclusive (29 days)" reconciles by dropping
// day 29 here; the spec count is what governs.

if (briefDrafts.length !== 29) {
  throw new Error(
    `[seed-mira-labs-month1-inbox] Brief plan must be exactly 29 entries; got ${briefDrafts.length}`,
  );
}

// ─── Weekly wraps plan ────────────────────────────────────────────────────────
const weeklyWrapsPlan: Array<{
  weekEndingAt: Date;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
  metrics: WeeklyWrapMetrics;
  emailSent: boolean;
}> = [
  {
    weekEndingAt: ist(2026, 4, 17, 17, 0), // Friday 17:00 IST = 11:30 UTC
    narrative:
      "Week 1 — Setup. FounderOS spun up; Maya/Theo/Iris connected to Slack/Gmail/Stripe. " +
      "Four April retainer summaries drafted by Iris and approved by Anita in a 6-minute Inbox session. " +
      "Theo drafted the first reply (Clearview Legal scope expansion). First daily briefs are sparse but coherent — " +
      "Maya's morning runs surfacing approvals and blockers cleanly. Total agent runs: 9 across 3 agents, " +
      "0 failures. MRR steady at $5,200 across Clearview, Bake House, Northwood Dental. Composio Slack/Gmail/Stripe " +
      "stayed active all week; no integration noise. The flagship narrative this week is the proof that the daily-brief + " +
      "approval-queue mechanic actually saves time vs the prior Notion-checklist baseline.",
    highlights: [
      { type: "activity", title: "FounderOS onboarding complete — 3 agents board configured" },
      { type: "issue_shipped", title: "Iris drafted 4 April retainer summaries" },
      { type: "decision_approved", title: "Anita approved all 4 retainer summaries (6 min Inbox session)" },
      { type: "activity", title: "Theo drafted Clearview Legal scope-expansion reply" },
    ],
    metrics: {
      issuesShipped: 5,
      decisionsApproved: 4,
      activityCount: 22,
      openBlockers: 0,
      agentSpendCents: 95,
    },
    emailSent: true,
  },
  {
    weekEndingAt: ist(2026, 4, 24, 17, 0),
    narrative:
      "Week 2 — Theo proves itself. Shore Capital discovery call → proposal drafted in 8 minutes vs the historical 4 hours. " +
      "Proposal sent, accepted, contract signed within 4 days. New retainer client #4 — MRR up to $6,400 (+$1,200, +23% MoM). " +
      "First failed run hit Wednesday (Theo OpenAI rate-limit on parallel proposals) — Maya picked it up in the next morning's " +
      "brief as a blocker, Anita retried manually, fixed. Iris's Friday finance digest landed in #mira-finance on schedule. " +
      "Captured 'OpenAI rate-limits >4 parallel' as a founder-note for future agent-config tuning. The week's leading insight: " +
      "Theo's proposal velocity now dwarfs Anita's available discovery-call count — pipeline bottleneck has shifted upstream.",
    highlights: [
      { type: "issue_shipped", title: "Shore Capital — proposal drafted, sent, contract signed (4-day cycle)" },
      { type: "decision_approved", title: "Anita approved Iris welcome retainer-onboarding for Shore Capital" },
      { type: "blocker", title: "Theo hit OpenAI rate-limit on parallel proposals (Apr 24)" },
      { type: "activity", title: "Iris Friday finance digest delivered to #mira-finance" },
    ],
    metrics: {
      issuesShipped: 6,
      decisionsApproved: 5,
      activityCount: 35,
      openBlockers: 0,
      agentSpendCents: 210,
    },
    emailSent: true,
  },
  {
    weekEndingAt: ist(2026, 5, 1, 17, 0),
    narrative:
      "Week 3 — The pivot week. Back-to-back discovery calls with a 200-staff manufacturing SaaS and a 30-person mid-market law " +
      "firm cluster. Maya synthesised both opportunities against current portfolio (1 dental, 1 bakery, 1 legal, 1 PE) and " +
      "recommended doubling down on professional services. Anita committed Wednesday April 30 — Theo's prompt template was " +
      "updated to emphasise compliance/document-extraction. Verdant Foods (manufacturing prospect) marked cancelled. " +
      "First decision capture in company_memory as kind=decision, pinned. Iris's May 1 retainer summaries fired clean — " +
      "Anita revised the Bake House draft to add a payment ask (overdue April invoice). The week's lesson: agent prompts " +
      "are mutable; the cost of a wedge decision is one agent_config_revisions row, not weeks of re-onboarding.",
    highlights: [
      { type: "decision_approved", title: "Pivot decision — pro-services wedge (legal/PE/insurance)" },
      { type: "issue_shipped", title: "Theo prompt template updated for pro-services positioning" },
      { type: "decision_approved", title: "Bake House May retainer revised to include payment ask" },
      { type: "blocker", title: "Bake House 6 days overdue on April invoice" },
    ],
    metrics: {
      issuesShipped: 7,
      decisionsApproved: 6,
      activityCount: 41,
      openBlockers: 1,
      agentSpendCents: 235,
    },
    emailSent: false, // email digest paused after pivot
  },
  {
    weekEndingAt: ist(2026, 5, 8, 17, 0),
    narrative:
      "Week 4 — Momentum + new lead. Theo's first post-pivot cold pitch went to SkyBridge Insurance (Anita got a warm intro " +
      "from Dr. Sharma at Northwood Dental). Shore Capital's 14-day decision_outcomes follow-up landed: WORKED — retainer running " +
      "clean, onboarding took 4 days vs target 7. Bake House silent on retainer summary — Iris elevated as a blocker, Maya picked " +
      "it up in the Wednesday brief. Anita rejected a Theo-drafted cold email to a friend's company (Verdant Foods) — felt too " +
      "aggressive. Nasscom event Friday: met Acme Retail's COO, hot lead, ~$2K/mo. Theo drafted the proposal that evening. " +
      "Friday digest landed on schedule. The week was the first that felt like compounding — every agent run added evidence " +
      "to the next decision.",
    highlights: [
      { type: "activity", title: "SkyBridge Insurance — first post-pivot cold pitch approved + sent" },
      { type: "decision_approved", title: "Shore Capital decision_outcomes: WORKED (14-day follow-up)" },
      { type: "blocker", title: "Bake House non-response 5+ days; 2nd overdue in 6mo" },
      { type: "activity", title: "Nasscom — Acme Retail hot lead surfaced" },
      { type: "issue_shipped", title: "Acme Retail proposal drafted by Theo (Friday eve)" },
    ],
    metrics: {
      issuesShipped: 8,
      decisionsApproved: 7,
      activityCount: 48,
      openBlockers: 2,
      agentSpendCents: 230,
    },
    emailSent: false,
  },
];

// ─── Approvals → DB inserts ───────────────────────────────────────────────────
type ApprovalRow = {
  id: string;
  narrativeKey: string;
  status: string;
  agent: "maya" | "theo" | "iris";
};

const insertedApprovals: ApprovalRow[] = [];

const summary = {
  approvals: 0,
  approvalComments: 0,
  issueApprovals: 0,
  dailyBriefs: 0,
  weeklyWraps: 0,
  notifications: 0,
  inboxState: 0,
};

await db.transaction(async (tx) => {
  // 1. APPROVALS — 25 new rows
  console.log("[seed-mira-labs-month1-inbox] approvals (25)…");

  // Look up existing approvals by payload.narrativeKey for idempotency
  const existingApprovalsRaw = (await tx.execute(
    sql`SELECT id, payload->>'narrativeKey' AS k, status, requested_by_agent_id AS agent_id
        FROM approvals
        WHERE company_id = ${MIRA}::uuid AND payload->>'persona' = ${PERSONA_TAG}`,
  )) as unknown as
    | Array<{ id: string; k: string | null; status: string; agent_id: string | null }>
    | { rows: Array<{ id: string; k: string | null; status: string; agent_id: string | null }> };

  const existingApprovalsList = Array.isArray(existingApprovalsRaw)
    ? existingApprovalsRaw
    : (existingApprovalsRaw.rows ?? []);
  const existingByKey = new Map<string, { id: string; status: string }>();
  for (const row of existingApprovalsList) {
    if (row.k) existingByKey.set(row.k, { id: row.id, status: row.status });
  }

  for (const p of plan) {
    if (existingByKey.has(p.narrativeKey)) {
      const exist = existingByKey.get(p.narrativeKey)!;
      insertedApprovals.push({
        id: exist.id,
        narrativeKey: p.narrativeKey,
        status: exist.status,
        agent: p.agent,
      });
      continue;
    }
    const id = randomUUID();
    const agentId = p.agent === "maya" ? MAYA : p.agent === "theo" ? THEO : IRIS;
    const agentName = p.agent === "maya" ? "Maya" : p.agent === "theo" ? "Theo" : "Iris";
    const createdAt = clampToRunNow(p.createdAt);
    const decidedAt =
      p.status === "approved" || p.status === "revision_requested" || p.rejected
        ? clampToRunNow(p.decidedAt ?? addMinutes(createdAt, 12))
        : null;

    // Build payload
    const payload: Record<string, unknown> = {
      action: p.action,
      summary: p.summary,
      agentName,
      requiresApproval: true,
      persona: PERSONA_TAG,
      narrativeKey: p.narrativeKey,
    };
    if (p.clientName) payload.client = p.clientName;
    if (p.gmailDraftIdx !== undefined) {
      // Counter starts at 005; gmailDraftIdx is 1-based
      const num = String(4 + p.gmailDraftIdx).padStart(3, "0");
      payload.gmailDraftId = `draft_placeholder_${num}`;
    }
    if (p.linkedPriorKey) payload.linkedPriorKey = p.linkedPriorKey;

    const finalStatus = p.rejected ? "rejected" : p.status;

    await tx.insert(approvals).values({
      id,
      companyId: MIRA,
      type: "agent_action",
      requestedByAgentId: agentId,
      status: finalStatus,
      payload,
      decisionNote: p.decisionNote,
      decidedByUserId: decidedAt ? ANITA_AUTH_UID : null,
      decidedAt,
      createdAt,
      updatedAt: decidedAt ?? createdAt,
    });
    insertedApprovals.push({
      id,
      narrativeKey: p.narrativeKey,
      status: finalStatus,
      agent: p.agent,
    });
    summary.approvals++;
  }

  // 2. APPROVAL_COMMENTS — ~15 rows on the revision-requested approvals + a few back-and-forth
  console.log("[seed-mira-labs-month1-inbox] approval_comments…");
  type CommentPlan = {
    approvalKey: string;
    author: "anita" | "iris" | "theo" | "maya";
    offsetMinutes: number; // from approval's createdAt
    body: string;
  };

  const commentPlans: CommentPlan[] = [
    // Bake House revision (Day 19 / May 1) — first approval (revision_requested)
    {
      approvalKey: "w3-iris-may1-bake-house-may-retainer-revision-requested",
      author: "anita",
      offsetMinutes: 4 * 60 + 30, // ~4.5h after createdAt, before decidedAt at +4h42m
      body: "Add a line asking about the overdue payment — I want to know if there's a problem before I just chase it.",
    },
    {
      approvalKey: "w3-iris-may1-bake-house-may-retainer-revision-requested",
      author: "iris",
      offsetMinutes: 4 * 60 + 35,
      body: "Got it — re-drafting with payment ask. Will queue the revised version in a fresh approval.",
    },
    // Bake House approved (revised)
    {
      approvalKey: "w3-iris-may1-bake-house-may-retainer-approved",
      author: "anita",
      offsetMinutes: 5,
      body: "Yes, this tone is right. Friendly, references the reorder script.",
    },
    {
      approvalKey: "w3-iris-may1-bake-house-may-retainer-approved",
      author: "iris",
      offsetMinutes: 8,
      body: "Approved — sending via draft_placeholder_011 (queued for execution after Composio guard).",
    },

    // Acme Retail revision (Day 30 / May 12) — first approval (revision_requested)
    {
      approvalKey: "w5-theo-may12-acme-retail-proposal-revision-requested",
      author: "anita",
      offsetMinutes: 5 * 60 + 30,
      body: "Trim the opening to 2 sentences. Lead with the support-triage outcome (95% auto-handled L1 tickets) not the audit pitch.",
    },
    {
      approvalKey: "w5-theo-may12-acme-retail-proposal-revision-requested",
      author: "theo",
      offsetMinutes: 5 * 60 + 35,
      body: "Understood — pivoting to outcome-led opening. Drafted v2; queued in a fresh approval row.",
    },
    // Acme approved
    {
      approvalKey: "w5-theo-may12-acme-retail-proposal-approved",
      author: "anita",
      offsetMinutes: 6,
      body: "Better. Outcome-first opening lands. Approving — please send tomorrow morning when their COO's online.",
    },
    {
      approvalKey: "w5-theo-may12-acme-retail-proposal-approved",
      author: "theo",
      offsetMinutes: 12,
      body: "Send queued for May 13 10:00 IST. Will surface confirmation in tomorrow's brief.",
    },

    // Shore Capital proposal — back-and-forth on the pricing
    {
      approvalKey: "w2-theo-apr20-shore-capital-proposal-draft",
      author: "anita",
      offsetMinutes: 5,
      body: "Bump setup to $3K — they've got budget. Otherwise looks good.",
    },
    {
      approvalKey: "w2-theo-apr20-shore-capital-proposal-draft",
      author: "theo",
      offsetMinutes: 9,
      body: "Updated to $3K setup. Re-rendered proposal; approval payload reflects the new number.",
    },

    // Clearview Legal scope-expansion reply
    {
      approvalKey: "w1-theo-apr17-clearview-scope-reply",
      author: "anita",
      offsetMinutes: 30,
      body: "Add a line confirming our compliance posture — Priya asked last call.",
    },
    {
      approvalKey: "w1-theo-apr17-clearview-scope-reply",
      author: "theo",
      offsetMinutes: 38,
      body: "Added — referenced ISO 27001 alignment in the closing paragraph.",
    },

    // Northwood Dental April summary
    {
      approvalKey: "w1-iris-apr15-northwood-dental-retainer",
      author: "anita",
      offsetMinutes: 11 * 60,
      body: "Nice catch on the June availability line. Approved.",
    },

    // SkyBridge Insurance cold pitch
    {
      approvalKey: "w4-theo-may4-skybridge-cold-pitch",
      author: "anita",
      offsetMinutes: 18,
      body: "Good. Compliance angle reads well. Send.",
    },

    // Rejected cold email — Anita's note alone, no agent reply
    {
      approvalKey: "w4-theo-may6-rejected-friend-cold-email",
      author: "anita",
      offsetMinutes: 4,
      body: "Too aggressive for someone I know personally. I'll handwrite this one — please skip the cold-email pipeline for friend-network targets going forward.",
    },
  ];

  // Idempotency: check existing comments by approvalId + body
  for (const cp of commentPlans) {
    const approvalRow = insertedApprovals.find((a) => a.narrativeKey === cp.approvalKey);
    if (!approvalRow) {
      console.warn(`[seed-mira-labs-month1-inbox] No approval found for comment key ${cp.approvalKey}`);
      continue;
    }
    // Re-find createdAt for the parent approval to anchor offsetMinutes
    const planEntry = plan.find((p) => p.narrativeKey === cp.approvalKey);
    if (!planEntry) continue;
    const createdAt = clampToRunNow(addMinutes(planEntry.createdAt, cp.offsetMinutes));

    // Idempotency: re-find by (approvalId, author, body)
    const existing = (await tx.execute(
      sql`SELECT id FROM approval_comments WHERE approval_id = ${approvalRow.id}::uuid AND body = ${cp.body} LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) continue;

    let authorAgentId: string | null = null;
    let authorUserId: string | null = null;
    if (cp.author === "anita") authorUserId = ANITA_AUTH_UID;
    else if (cp.author === "iris") authorAgentId = IRIS;
    else if (cp.author === "theo") authorAgentId = THEO;
    else if (cp.author === "maya") authorAgentId = MAYA;

    await tx.insert(approvalComments).values({
      companyId: MIRA,
      approvalId: approvalRow.id,
      authorAgentId,
      authorUserId,
      body: cp.body,
      createdAt,
      updatedAt: createdAt,
    });
    summary.approvalComments++;
  }

  // 3. ISSUE_APPROVALS — link approvals to MIR-NNN issues
  console.log("[seed-mira-labs-month1-inbox] issue_approvals…");
  if (Object.keys(issuesMap).length === 0) {
    console.warn("[seed-mira-labs-month1-inbox] Skipping issue_approvals (no issues.json)");
  } else {
    // Map narrative key → issue identifier
    const issueLinkMap: Record<string, string> = {
      "w1-iris-apr15-clearview-legal-retainer": "MIR-008",
      "w1-iris-apr15-bake-house-may-retainer": "MIR-009", // (none — wrong key, fix below)
      "w1-iris-apr15-bake-house-retainer": "MIR-009",
      "w1-iris-apr15-northwood-dental-retainer": "MIR-010",
      "w1-theo-apr17-clearview-scope-reply": "MIR-011",
      "w2-theo-apr20-shore-capital-proposal-draft": "MIR-012",
      "w2-theo-apr21-shore-capital-follow-up": "MIR-013",
      "w2-iris-apr22-shore-capital-welcome-retainer": "MIR-014",
      "w3-maya-apr29-pivot-slack-announcement": "MIR-019",
      "w3-maya-apr30-theo-prompt-swap-confirmation": "MIR-020",
      "w3-iris-may1-clearview-legal-may-retainer": "MIR-023",
      "w3-iris-may1-northwood-dental-may-retainer": "MIR-021",
      "w3-iris-may1-bake-house-may-retainer-revision-requested": "MIR-022",
      "w3-iris-may1-bake-house-may-retainer-approved": "MIR-022",
      "w4-theo-may4-skybridge-cold-pitch": "MIR-025",
      "w4-theo-may6-rejected-friend-cold-email": "MIR-015", // Verdant Foods cancelled
      "w4-maya-may8-friday-digest": "MIR-026", // Bake House blocker
      "w4-iris-may9-shore-capital-first-month-summary": "MIR-024",
      "w5-theo-may11-fielding-prep-email": "MIR-029",
      "w5-maya-may11-brief-approval": "MIR-033",
      "w5-theo-may12-acme-retail-proposal-revision-requested": "MIR-028",
      "w5-theo-may12-acme-retail-proposal-approved": "MIR-028",
    };

    for (const [narrativeKey, issueIdent] of Object.entries(issueLinkMap)) {
      const issueId = issuesMap[issueIdent];
      if (!issueId) {
        console.warn(`[seed-mira-labs-month1-inbox] No issue UUID for ${issueIdent}`);
        continue;
      }
      const approvalRow = insertedApprovals.find((a) => a.narrativeKey === narrativeKey);
      if (!approvalRow) continue;

      // Compute agentId for linkedByAgentId
      const linkedByAgentId =
        approvalRow.agent === "maya" ? MAYA : approvalRow.agent === "theo" ? THEO : IRIS;

      const planEntry = plan.find((p) => p.narrativeKey === narrativeKey);
      const linkedAt = planEntry ? clampToRunNow(planEntry.createdAt) : RUN_NOW;

      // PK is (issueId, approvalId) → onConflictDoNothing
      const result = await tx
        .insert(issueApprovals)
        .values({
          companyId: MIRA,
          issueId,
          approvalId: approvalRow.id,
          linkedByAgentId,
          linkedByUserId: null,
          createdAt: linkedAt,
        })
        .onConflictDoNothing()
        .returning({ approvalId: issueApprovals.approvalId });
      if (result.length > 0) summary.issueApprovals++;
    }
  }

  // 4. DAILY_BRIEFS — 29 new rows (Apr 13 → May 12; today's is pre-seeded)
  console.log("[seed-mira-labs-month1-inbox] daily_briefs (29)…");

  // Build approvalKey → approvalId lookup for topThreeActions
  const approvalByKey = new Map<string, string>();
  for (const a of insertedApprovals) approvalByKey.set(a.narrativeKey, a.id);

  for (const draft of briefDrafts) {
    const { iso, localDate } = dayDate(draft.dayIdx);

    // generatedAt = IST 07:00..07:45 on the for_date
    const generatedAt = clampToRunNow(
      new Date(
        localDate.getTime() + (draft.generatedHour * 60 + draft.generatedMin) * 60_000,
      ),
    );
    const emailSentAt = draft.emailSent
      ? clampToRunNow(addHours(generatedAt, 1))
      : null;

    // Resolve approvalIds in topThreeActions
    const topThreeActions = draft.pendingActions.map((a) => {
      const out: { action: string; rationale: string; approvalId?: string } = {
        action: a.action,
        rationale: a.rationale,
      };
      if (a.approvalKey && approvalByKey.has(a.approvalKey)) {
        out.approvalId = approvalByKey.get(a.approvalKey)!;
      }
      return out;
    });

    const payload: DailyBriefPayload = {
      headline: draft.headline,
      kpiMovements: [draft.kpi as any],
      anomalies: [], // Wave D fills these via insightIds
      blockers: draft.blockers as any,
      opportunities: [], // Wave D fills via insightIds
      topThreeActions,
    };

    await tx
      .insert(dailyBriefs)
      .values({
        companyId: MIRA,
        forDate: iso,
        payload,
        generatedAt,
        emailSentAt,
      })
      .onConflictDoNothing();
    summary.dailyBriefs++;
  }

  // Verify count via re-query
  const dailyBriefCountRaw = (await tx.execute(
    sql`SELECT COUNT(*)::int AS c FROM daily_briefs WHERE company_id = ${MIRA}::uuid`,
  )) as unknown as Array<{ c: number }> | { rows: Array<{ c: number }> };
  const briefCount = Array.isArray(dailyBriefCountRaw)
    ? dailyBriefCountRaw[0]?.c
    : (dailyBriefCountRaw.rows ?? [])[0]?.c;
  console.log(`[seed-mira-labs-month1-inbox] daily_briefs total after insert: ${briefCount}`);

  // 5. WEEKLY_WRAPS — 4 rows
  console.log("[seed-mira-labs-month1-inbox] weekly_wraps (4)…");
  for (const ww of weeklyWrapsPlan) {
    const deliveredToSlackAt = clampToRunNow(addMinutes(ww.weekEndingAt, 5));
    const deliveredToEmailAt = ww.emailSent
      ? clampToRunNow(addHours(ww.weekEndingAt, 4))
      : null;

    await tx
      .insert(weeklyWraps)
      .values({
        companyId: MIRA,
        weekEndingAt: ww.weekEndingAt,
        narrative: ww.narrative,
        highlights: ww.highlights,
        metrics: ww.metrics,
        deliveredToSlackAt,
        deliveredToEmailAt,
        slackChannelId: "C_MIRA_FINANCE",
        createdAt: deliveredToSlackAt,
      })
      .onConflictDoNothing();
    summary.weeklyWraps++;
  }

  // 6. NOTIFICATIONS — 20 rows
  console.log("[seed-mira-labs-month1-inbox] notifications (20)…");

  type NotifPlan = {
    kind: "approval_needed" | "insight_critical" | "workflow_completed" | "integration_failed";
    title: string;
    body: string | null;
    refKind: "approval" | "insight" | "workflow_run" | "integration";
    refId: string;
    createdAt: Date;
    readAt: Date | null;
  };

  const notifPlans: NotifPlan[] = [];

  // 10 approval_needed: 5 historical READ (pre-decided approvals) + 5 UNREAD
  // (the 5 pre-seeded pending approvals). Re-find pre-seeded pending approvals.
  const pendingPreseededRaw = (await tx.execute(
    sql`SELECT id FROM approvals WHERE company_id = ${MIRA}::uuid AND status = 'pending' ORDER BY created_at`,
  )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
  const pendingPreseeded = Array.isArray(pendingPreseededRaw)
    ? pendingPreseededRaw
    : (pendingPreseededRaw.rows ?? []);

  // Unread approval_needed → for the 5 pre-seeded pending. Anchor createdAt
  // at "today" so the bell badge shows them.
  for (let i = 0; i < Math.min(pendingPreseeded.length, 5); i++) {
    const id = pendingPreseeded[i]!.id;
    notifPlans.push({
      kind: "approval_needed",
      title: "Approval awaiting your review",
      body: "Inbox has 5 pending agent actions for today.",
      refKind: "approval",
      refId: id,
      createdAt: clampToRunNow(addMinutes(RUN_NOW, -10 + i)),
      readAt: null,
    });
  }

  // Read approval_needed → 5 picked from key approvals over 30d
  const readApprovalKeys = [
    "w2-theo-apr20-shore-capital-proposal-draft",
    "w3-iris-may1-bake-house-may-retainer-revision-requested",
    "w3-maya-apr30-theo-prompt-swap-confirmation",
    "w4-theo-may4-skybridge-cold-pitch",
    "w5-theo-may12-acme-retail-proposal-revision-requested",
  ];
  for (const key of readApprovalKeys) {
    const a = insertedApprovals.find((x) => x.narrativeKey === key);
    if (!a) continue;
    const planEntry = plan.find((p) => p.narrativeKey === key);
    if (!planEntry) continue;
    const createdAt = clampToRunNow(planEntry.createdAt);
    notifPlans.push({
      kind: "approval_needed",
      title: `Approval awaiting your review · ${planEntry.summary}`,
      body: null,
      refKind: "approval",
      refId: a.id,
      createdAt,
      readAt: clampToRunNow(addMinutes(createdAt, 18)),
    });
  }

  // 4 insight_critical (use synthetic refIds — Wave D will create the real insights)
  // For now we use deterministic UUID strings derived from narrative keys.
  const synthInsightId = (key: string) => {
    // Generate a stable v4-shaped UUID per key by hashing into 16-byte hex.
    // Simpler: use a fixed prefix + a hash-derived suffix.
    let h = 0;
    for (const c of key) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    const hex = Math.abs(h).toString(16).padStart(8, "0").slice(0, 8);
    return `00000000-0000-0000-0000-${hex.padEnd(12, "0")}`;
  };

  const insightCriticals: Array<{
    title: string;
    body: string;
    insightKey: string;
    createdAt: Date;
    readAt: Date | null;
  }> = [
    {
      title: "Bake House $1,200 invoice 3d overdue",
      body: "Iris flagged — second overdue event in 6 months. Possible at-risk customer.",
      insightKey: "bake-house-overdue-blocker",
      createdAt: dayTime(27, 8, 12),
      readAt: dayTime(27, 9, 14),
    },
    {
      title: "Theo OpenAI spend spike +180% on Apr 24",
      body: "Maya picked up rate-limit failures in morning brief; spend overshot daily run-rate.",
      insightKey: "theo-openai-spike-apr24",
      createdAt: dayTime(11, 7, 38),
      readAt: dayTime(11, 7, 56),
    },
    {
      title: "Pivot recommendation — pro-services wedge",
      body: "Maya synthesised both discovery calls. Confidence 0.7; ready for decision capture.",
      insightKey: "pivot-pro-services",
      createdAt: dayTime(16, 18, 24),
      readAt: dayTime(16, 18, 32),
    },
    {
      title: "Cumulative agent spend $8.20 — 60% under budget",
      body: "Iris flagged in Friday digest; runway impact: +2 weeks vs plan.",
      insightKey: "spend-under-budget",
      createdAt: dayTime(22, 17, 14),
      readAt: null, // recent unread
    },
  ];
  for (const ic of insightCriticals) {
    notifPlans.push({
      kind: "insight_critical",
      title: ic.title,
      body: ic.body,
      refKind: "insight",
      refId: synthInsightId(ic.insightKey),
      createdAt: clampToRunNow(ic.createdAt),
      readAt: ic.readAt ? clampToRunNow(ic.readAt) : null,
    });
  }

  // 3 workflow_completed — weekly wraps 1, 2, 3 (week 4 email paused)
  const wrapsForNotif = weeklyWrapsPlan.slice(0, 3);
  for (let i = 0; i < wrapsForNotif.length; i++) {
    const ww = wrapsForNotif[i]!;
    const createdAt = clampToRunNow(addMinutes(ww.weekEndingAt, 5));
    notifPlans.push({
      kind: "workflow_completed",
      title: `Weekly Wrap delivered · week ending ${istLocalDate(ww.weekEndingAt)}`,
      body: ww.narrative.slice(0, 160) + "…",
      refKind: "workflow_run",
      refId: synthInsightId(`weekly-wrap-${i}`),
      createdAt,
      readAt: clampToRunNow(addHours(createdAt, 6)),
    });
  }

  // 3 integration_failed — Apr 14 Slack rate-limit, Apr 30 Stripe timeout, May 5 Anthropic 529
  const integrationFailures: Array<{
    title: string;
    body: string;
    integrationKey: string;
    createdAt: Date;
  }> = [
    {
      title: "Slack integration — rate-limit hit",
      body: "Composio reported 429 on Slack read; Maya morning brief retried successfully.",
      integrationKey: "slack-apr14",
      createdAt: ist(2026, 4, 14, 7, 42),
    },
    {
      title: "Stripe integration — timeout",
      body: "Iris run failed with stripe_timeout; retry not auto-queued.",
      integrationKey: "stripe-apr30",
      createdAt: ist(2026, 4, 30, 11, 6),
    },
    {
      title: "Anthropic API — 529 overloaded",
      body: "Maya morning brief hit 529; retry-with-backoff succeeded after 30s.",
      integrationKey: "anthropic-may5",
      createdAt: ist(2026, 5, 5, 7, 24),
    },
  ];
  for (const f of integrationFailures) {
    notifPlans.push({
      kind: "integration_failed",
      title: f.title,
      body: f.body,
      refKind: "integration",
      refId: synthInsightId(f.integrationKey),
      createdAt: clampToRunNow(f.createdAt),
      readAt: clampToRunNow(addHours(f.createdAt, 2)),
    });
  }

  // Insert with idempotency check by (companyId, userId, kind, refKind, refId)
  for (const n of notifPlans) {
    const existing = (await tx.execute(
      sql`SELECT id FROM notifications
          WHERE company_id = ${MIRA}::uuid AND user_id = ${ANITA_AUTH_UID}
            AND kind = ${n.kind} AND ref_kind = ${n.refKind} AND ref_id = ${n.refId}
          LIMIT 1`,
    )) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
    const existingArr = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingArr.length > 0) continue;

    await tx.insert(notifications).values({
      companyId: MIRA,
      userId: ANITA_AUTH_UID,
      kind: n.kind,
      title: n.title,
      body: n.body,
      refKind: n.refKind,
      refId: n.refId,
      readAt: n.readAt,
      createdAt: n.createdAt,
    });
    summary.notifications++;
  }

  // 7. INBOX_STATE — 30 rows
  console.log("[seed-mira-labs-month1-inbox] inbox_state (30)…");

  // 5 unread (pre-seeded pending approvals)
  for (const p of pendingPreseeded.slice(0, 5)) {
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "approval",
        entityId: p.id,
        state: "unread",
        readAt: null,
        archivedAt: null,
        snoozedUntil: null,
        createdAt: clampToRunNow(addMinutes(RUN_NOW, -10)),
        updatedAt: clampToRunNow(addMinutes(RUN_NOW, -10)),
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  // 15 read approvals (pick first 15 inserted, exclude revision-requested intermediate)
  const readApprovalCandidates = insertedApprovals
    .filter((a) => a.status === "approved" || a.status === "rejected")
    .slice(0, 15);
  for (const a of readApprovalCandidates) {
    const planEntry = plan.find((p) => p.narrativeKey === a.narrativeKey);
    if (!planEntry) continue;
    const decidedAt = clampToRunNow(planEntry.decidedAt ?? addMinutes(planEntry.createdAt, 12));
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "approval",
        entityId: a.id,
        state: "read",
        readAt: decidedAt,
        archivedAt: null,
        snoozedUntil: null,
        createdAt: clampToRunNow(planEntry.createdAt),
        updatedAt: decidedAt,
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  // 5 read on issues
  const readIssueIdents = ["MIR-019", "MIR-026", "MIR-028", "MIR-022", "MIR-014"];
  for (const ident of readIssueIdents) {
    const issueId = issuesMap[ident];
    if (!issueId) continue;
    const ts = ist(2026, 5, 10, 9, 14);
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "issue",
        entityId: issueId,
        state: "read",
        readAt: clampToRunNow(ts),
        archivedAt: null,
        snoozedUntil: null,
        createdAt: clampToRunNow(addMinutes(ts, -120)),
        updatedAt: clampToRunNow(ts),
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  // 3 archived (old resolved blockers). The 15 "read" approvals already covered
  // positions 0-14 in insertedApprovals filtered to approved+rejected. We want
  // archives that don't collide with read or with the snoozed approval below.
  // Pick approvals at positions 15-17 of approved-only (mid-window approvals).
  // Also explicitly exclude the snoozed key.
  const SNOOZED_APPROVAL_KEY = "w5-theo-may11-fielding-prep-email";
  const archivedSet = insertedApprovals
    .filter((a) => a.status === "approved" && a.narrativeKey !== SNOOZED_APPROVAL_KEY)
    .slice(15, 18);
  for (const a of archivedSet) {
    const planEntry = plan.find((p) => p.narrativeKey === a.narrativeKey);
    if (!planEntry) continue;
    const archivedAt = clampToRunNow(
      planEntry.decidedAt
        ? addHours(planEntry.decidedAt, 24)
        : addHours(planEntry.createdAt, 25),
    );
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "approval",
        entityId: a.id,
        state: "archived",
        readAt: planEntry.decidedAt ? clampToRunNow(planEntry.decidedAt) : null,
        archivedAt,
        snoozedUntil: null,
        createdAt: clampToRunNow(planEntry.createdAt),
        updatedAt: archivedAt,
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  // 2 snoozed: one approval (Anita pushed to weekend), one issue
  const snoozedApproval = insertedApprovals.find((a) => a.narrativeKey === SNOOZED_APPROVAL_KEY);
  if (snoozedApproval) {
    const snoozedUntil = ist(2026, 5, 17, 10, 0); // future Sat 17 — but Cap to runNow
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "approval",
        entityId: snoozedApproval.id,
        state: "snoozed",
        readAt: null,
        archivedAt: null,
        snoozedUntil, // future date is OK for snoozedUntil (it's a *target* time)
        createdAt: clampToRunNow(addHours(RUN_NOW, -10)),
        updatedAt: clampToRunNow(addHours(RUN_NOW, -10)),
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  const snoozedIssueId = issuesMap["MIR-035"];
  if (snoozedIssueId) {
    const snoozedUntil = ist(2026, 5, 20, 10, 0); // future
    await tx
      .insert(inboxState)
      .values({
        userId: ANITA_AUTH_UID,
        entityType: "issue",
        entityId: snoozedIssueId,
        state: "snoozed",
        readAt: null,
        archivedAt: null,
        snoozedUntil,
        createdAt: clampToRunNow(addHours(RUN_NOW, -5)),
        updatedAt: clampToRunNow(addHours(RUN_NOW, -5)),
      })
      .onConflictDoNothing();
    summary.inboxState++;
  }

  // 8. Write approvals.json output
  const approvalsJson: Record<string, string> = {};
  for (const a of insertedApprovals) {
    approvalsJson[a.narrativeKey] = a.id;
  }
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
        "[seed-mira-labs-month1-inbox] No .planning/loop-2026-05-13-04 dir found — skipping approvals.json write.",
      );
    } else {
      const outPath = `${base}/.planning/loop-2026-05-13-04/seeded-ids/approvals.json`;
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(approvalsJson, null, 2));
      console.log(
        `[seed-mira-labs-month1-inbox] Wrote ${Object.keys(approvalsJson).length} approval IDs → ${outPath}`,
      );
    }
  } catch (e) {
    console.warn(
      `[seed-mira-labs-month1-inbox] Could not write approvals.json (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});

// ─── End-of-run summary ───────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-inbox] Inserted:
  approvals          : ${summary.approvals}
  approval_comments  : ${summary.approvalComments}
  issue_approvals    : ${summary.issueApprovals}
  daily_briefs       : ${summary.dailyBriefs}
  weekly_wraps       : ${summary.weeklyWraps}
  notifications      : ${summary.notifications}
  inbox_state        : ${summary.inboxState}
`);

process.exit(0);
