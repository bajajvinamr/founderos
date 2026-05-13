/**
 * seed-mira-labs-month1-issues.ts — Wave 2 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent B):
 *   - labels                : 8 rows (client/pipeline/internal/finance/pivot/
 *                             pro-services/urgent-attention/recurring)
 *   - issues                : 30 rows (MIR-006 .. MIR-035) per spec §3.5
 *   - issue_comments        : 40 rows per spec §3.8
 *   - issue_labels          : ~50 rows per spec §3.9 coherence rules
 *   - issue_relations       : 6 rows (type='blocks') per spec §3.10
 *
 * Coherence:
 *   - Every `done` issue with assignee_agent_id != null links to a
 *     heartbeat_runs row via execution_run_id (succeeded run, same agent,
 *     same calendar day in IST).
 *   - origin_kind = 'routine_execution' for Iris retainer-summary issues
 *     (MIR-008..010, MIR-021..024); origin_kind = 'manual' otherwise.
 *   - DO NOT touch the 5 pre-seeded issues (MIR-001..005).
 *   - MIR-028 (Acme Retail) wires to the $10K MRR goal + Q2 project (best
 *     effort lookup by title; graceful fall-through if missing).
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-issues.ts
 *
 * Re-run safety: every insert uses onConflictDoNothing on natural UNIQUE
 * constraints (issues.identifier, labels.(company,name), issue_labels PK,
 * issue_relations edge UQ). Existing rows are preserved; new rows are added
 * idempotently. The whole script runs inside a single transaction so partial
 * failures roll back cleanly.
 *
 * Hard limits (council carries from main seed):
 *   - NEVER touch instance_api_keys (council condition #4)
 *   - NEVER set companies.is_demo = true (DB trigger 0109 rejects)
 *   - Do NOT modify agents/companies/goals/projects rows
 *   - All issue priority values from {critical, high, medium, low}
 *     (NOT 'urgent' — that's pre-existing legacy on MIR-001..005)
 *   - All timestamps in the past (cap at "now")
 */

import { sql, eq, and, inArray } from "drizzle-orm";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "./client.js";
import {
  companies,
  agents,
  goals,
  projects,
  issues,
  labels,
  issueLabels,
  issueComments,
  issueRelations,
  heartbeatRuns,
} from "./schema/index.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-issues] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-issues] DATABASE_URL is required");
  process.exit(1);
}

const PERSONA_TAG = "mira-labs-dogfood";
const ANITA_AUTH_UID = "9b29fdf9-2ddb-4919-8fd2-77e4640849c9";

// ─── Time helpers ─────────────────────────────────────────────────────────────
// All temporal anchors are IST (UTC+05:30). Day 1 = 2026-04-13 (Mon).
// "Today" = 2026-05-13 (Wed). Never emit timestamps after RUN_NOW.
const IST_OFFSET_MIN = 330; // +05:30
const RUN_NOW = new Date("2026-05-13T08:30:00+05:30");

function ist(
  year: number,
  month: number, // 1-12
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

// ─── DB setup ─────────────────────────────────────────────────────────────────
const db = createDb(DATABASE_URL);

console.log(
  "[seed-mira-labs-month1-issues] Looking up Mira Labs company + agents…",
);

const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];

if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-issues] Mira Labs company not found. Run scripts/seed-mira-labs.ts (Wave 0) first.",
  );
  process.exit(1);
}
const MIRA = companyRow.id;

const agentRows = await db
  .select({ id: agents.id, name: agents.name })
  .from(agents)
  .where(eq(agents.companyId, MIRA));

const findAgent = (name: string): { id: string; name: string } => {
  const a = agentRows.find((r) => r.name === name);
  if (!a) throw new Error(`Agent not found: ${name}`);
  return a;
};
const MAYA = findAgent("Maya");
const THEO = findAgent("Theo");
const IRIS = findAgent("Iris");

console.log(
  `[seed-mira-labs-month1-issues] MIRA=${MIRA} MAYA=${MAYA.id} THEO=${THEO.id} IRIS=${IRIS.id}`,
);

// ─── Best-effort goal/project lookup ──────────────────────────────────────────
// MIR-028 (Acme Retail) wants goalId = the $10K MRR goal + projectId = Q2.
// We look these up by title — fall through to null if not present so the
// script still completes against a partial seed.
const goalRows = await db
  .select({ id: goals.id, title: goals.title })
  .from(goals)
  .where(eq(goals.companyId, MIRA));
const GOAL_10K_MRR =
  goalRows.find((g) => g.title.toLowerCase().includes("10k mrr"))?.id ?? null;

const projectRows = await db
  .select({ id: projects.id, name: projects.name })
  .from(projects)
  .where(eq(projects.companyId, MIRA));
const Q2_PROJECT =
  projectRows.find((p) => p.name.toLowerCase().includes("q2"))?.id ?? null;

console.log(
  `[seed-mira-labs-month1-issues] GOAL_10K_MRR=${GOAL_10K_MRR ?? "<missing>"} Q2_PROJECT=${Q2_PROJECT ?? "<missing>"}`,
);

// ─── Heartbeat-run lookup for execution_run_id linking ────────────────────────
// Build a per-(agent, date) cache of succeeded heartbeat_runs ids.
// For each `done` issue with an agent assignee, we pick one run on the same
// calendar day (IST) and link via execution_run_id.
type RunIndex = Map<string /* `${agentId}:${YYYY-MM-DD}` */, string[]>;
const runIndex: RunIndex = new Map();

{
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      finishedAt: heartbeatRuns.finishedAt,
      startedAt: heartbeatRuns.startedAt,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, MIRA));
  for (const r of rows) {
    if (r.status !== "succeeded") continue;
    const ts = r.finishedAt ?? r.startedAt;
    if (!ts) continue;
    const date = istLocalDate(new Date(ts));
    const key = `${r.agentId}:${date}`;
    const arr = runIndex.get(key);
    if (arr) arr.push(r.id);
    else runIndex.set(key, [r.id]);
  }
}

const pickRunFor = (agentId: string, day: Date): string | null => {
  const date = istLocalDate(day);
  const key = `${agentId}:${date}`;
  const arr = runIndex.get(key);
  if (arr && arr.length > 0) return arr[0]!;
  // Fall back: nearest day (±2) for that agent.
  for (const offset of [-1, 1, -2, 2]) {
    const altDay = new Date(day.getTime() + offset * 86_400_000);
    const altKey = `${agentId}:${istLocalDate(altDay)}`;
    const altArr = runIndex.get(altKey);
    if (altArr && altArr.length > 0) return altArr[0]!;
  }
  return null;
};

console.log(
  `[seed-mira-labs-month1-issues] Indexed ${[...runIndex.values()].reduce((n, a) => n + a.length, 0)} succeeded heartbeat_runs across ${runIndex.size} (agent, day) keys.`,
);

// ─── Label catalogue (spec §3.9) ──────────────────────────────────────────────
type LabelDef = { name: string; color: string };
const labelDefs: LabelDef[] = [
  { name: "client", color: "#3b82f6" },
  { name: "pipeline", color: "#22c55e" },
  { name: "internal", color: "#6b7280" },
  { name: "finance", color: "#eab308" },
  { name: "pivot", color: "#a855f7" },
  { name: "pro-services", color: "#7c3aed" },
  { name: "urgent-attention", color: "#ef4444" },
  { name: "recurring", color: "#06b6d4" },
];

// ─── Issue plan (spec §3.5 narrative — 30 rows MIR-006..MIR-035) ──────────────
type IssuePlan = {
  number: number; // 6..35
  identifier: string; // MIR-NNN
  title: string;
  description: string;
  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "in_review"
    | "done"
    | "blocked"
    | "cancelled";
  priority: "critical" | "high" | "medium" | "low";
  assigneeAgent: "MAYA" | "THEO" | "IRIS" | null;
  assigneeUser: boolean; // ANITA assignee
  createdByAgent: "MAYA" | "THEO" | "IRIS" | null;
  originKind: "manual" | "routine_execution";
  originId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  labels: string[];
  withGoal?: boolean; // MIR-028 only
  withProject?: boolean; // MIR-028 only
};

const pad3 = (n: number): string => String(n).padStart(3, "0");

// Day 1 = 2026-04-13 IST
const day = (idx: number): Date =>
  new Date(ist(2026, 4, 13, 0, 0).getTime() + idx * 86_400_000);

const issuePlans: IssuePlan[] = [
  // MIR-006 (Apr 13 / Day 1, done): Anita connects Slack
  {
    number: 6,
    identifier: "MIR-006",
    title: "FounderOS — connect Slack via Composio",
    description:
      "Day 1 onboarding step. Wire #mira-team into Composio so Maya can read morning context. Took 4 minutes including OAuth dance.",
    status: "done",
    priority: "medium",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(0).getTime() + 11 * 3_600_000),
    completedAt: new Date(day(0).getTime() + 11 * 3_600_000 + 4 * 60_000),
    cancelledAt: null,
    labels: ["internal"],
  },
  // MIR-007 (Apr 14 / Day 2, done): Iris first Stripe review
  {
    number: 7,
    identifier: "MIR-007",
    title: "Iris — first Stripe invoice review",
    description:
      "Day 2. Iris's first wakeup after Stripe Composio connection. Flagged Bake House April invoice as upcoming due May 7.",
    status: "done",
    priority: "medium",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(1).getTime() + 18 * 3_600_000),
    completedAt: new Date(day(1).getTime() + 18 * 3_600_000 + 6 * 60_000),
    cancelledAt: null,
    labels: ["finance", "internal"],
  },
  // MIR-008 (Apr 15 / Day 3, done): Iris retainer summary — Clearview Legal
  {
    number: 8,
    identifier: "MIR-008",
    title: "Clearview Legal — April retainer summary",
    description:
      "Iris drafted 1-page retainer summary for Clearview Legal: contract clauses extracted in April (47), matter summaries delivered (12), next-month scope (constitutional law review project).",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-clearview-2026-04-15",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000),
    completedAt: new Date(day(2).getTime() + 9 * 3_600_000 + 8 * 60_000),
    cancelledAt: null,
    labels: ["client", "finance", "recurring", "pro-services"],
  },
  // MIR-009 (Apr 15, done): Iris retainer summary — Bake House
  {
    number: 9,
    identifier: "MIR-009",
    title: "Bake House — April retainer summary",
    description:
      "Iris drafted retainer summary for Bake House: inventory reorder script kept 6 locations from stockout in April, ~12h of manual work avoided.",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-bakehouse-2026-04-15",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000 + 8 * 60_000),
    completedAt: new Date(day(2).getTime() + 9 * 3_600_000 + 16 * 60_000),
    cancelledAt: null,
    labels: ["client", "finance", "recurring"],
  },
  // MIR-010 (Apr 15, done): Iris retainer summary — Northwood Dental
  {
    number: 10,
    identifier: "MIR-010",
    title: "Northwood Dental — April retainer summary",
    description:
      "Iris drafted retainer summary for Northwood Dental: 3 clinics, intake-form processor handled 247 forms in April, appointment-reminder workflow sent 1,840 SMS.",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-northwood-2026-04-15",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000 + 16 * 60_000),
    completedAt: new Date(day(2).getTime() + 9 * 3_600_000 + 24 * 60_000),
    cancelledAt: null,
    labels: ["client", "finance", "recurring"],
  },
  // MIR-011 (Apr 17 / Day 5, done): Theo drafts Clearview scope-expansion reply
  {
    number: 11,
    identifier: "MIR-011",
    title: "Clearview Legal — scope expansion reply",
    description:
      "Priya Iyer asked about adding constitutional-law clause extraction to current scope. Theo drafted a +$800/mo expansion proposal. Anita reviewed, sent.",
    status: "done",
    priority: "high",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: "THEO",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(4).getTime() + 14 * 3_600_000),
    completedAt: new Date(day(4).getTime() + 16 * 3_600_000),
    cancelledAt: null,
    labels: ["client", "pro-services"],
  },
  // MIR-012 (Apr 20 / Day 8, done): Theo Shore Capital discovery proposal
  {
    number: 12,
    identifier: "MIR-012",
    title: "Shore Capital — discovery call proposal draft",
    description:
      "Anita pasted Shore Capital discovery transcript into Theo. Drafted proposal in 8 minutes vs historical 4 hours — first 'wow moment.' Investment-memo formatter, $1,000/mo + $2,500 setup.",
    status: "done",
    priority: "high",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: "THEO",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(7).getTime() + 11 * 3_600_000),
    completedAt: new Date(day(7).getTime() + 11 * 3_600_000 + 12 * 60_000),
    cancelledAt: null,
    labels: ["pipeline", "client"],
  },
  // MIR-013 (Apr 21 / Day 9, done): Anita sends Shore Capital proposal
  {
    number: 13,
    identifier: "MIR-013",
    title: "Shore Capital — proposal sent",
    description:
      "Anita approved Theo's draft (small tone edit on opener) and sent. Reply expected within 48h.",
    status: "done",
    priority: "medium",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(8).getTime() + 10 * 3_600_000),
    completedAt: new Date(day(8).getTime() + 11 * 3_600_000),
    cancelledAt: null,
    labels: ["pipeline", "client"],
  },
  // MIR-014 (Apr 23 / Day 11, done): Shore Capital signed
  {
    number: 14,
    identifier: "MIR-014",
    title: "Shore Capital — contract signed, kick-off scheduled",
    description:
      "Shore Capital signed at full rate ($1,000/mo). Stripe customer.created event fired. Kick-off May 1.",
    status: "done",
    priority: "high",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(10).getTime() + 15 * 3_600_000),
    completedAt: new Date(day(10).getTime() + 16 * 3_600_000),
    cancelledAt: null,
    labels: ["client"],
  },
  // MIR-015 (Apr 24 / Day 12, cancelled): Verdant Foods manufacturing
  {
    number: 15,
    identifier: "MIR-015",
    title: "Verdant Foods — manufacturing prospect proposal",
    description:
      "Manufacturing-SaaS pivot prospect. Theo run hit OpenAI rate limit (429). Eventually cancelled when Anita committed to professional-services wedge on Apr 30.",
    status: "cancelled",
    priority: "low",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: "THEO",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(11).getTime() + 13 * 3_600_000),
    completedAt: null,
    cancelledAt: ist(2026, 4, 30, 14, 25),
    labels: ["pipeline", "pivot"],
  },
  // MIR-016 (Apr 24, done): Maya morning brief flagged Verdant rate-limit
  {
    number: 16,
    identifier: "MIR-016",
    title: "Maya — morning brief flagged Verdant Foods rate-limit failure",
    description:
      "Meta. Maya's Apr 24 morning brief flagged Theo's overnight OpenAI 429 on the Verdant Foods proposal. Anita retried manually 30min later — succeeded.",
    status: "done",
    priority: "low",
    assigneeAgent: "MAYA",
    assigneeUser: false,
    createdByAgent: "MAYA",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(11).getTime() + 7 * 3_600_000 + 30 * 60_000),
    completedAt: new Date(day(11).getTime() + 7 * 3_600_000 + 38 * 60_000),
    cancelledAt: null,
    labels: ["internal"],
  },
  // MIR-017 (Apr 27 / Day 15, done): manufacturing discovery
  {
    number: 17,
    identifier: "MIR-017",
    title: "Discovery call — manufacturing prospect (TBD)",
    description:
      "200-staff manufacturing-floor SaaS. Strong fit on paper, but no warm references in vertical. Surfaced the wedge question.",
    status: "done",
    priority: "medium",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(14).getTime() + 15 * 3_600_000),
    completedAt: new Date(day(14).getTime() + 16 * 3_600_000),
    cancelledAt: null,
    labels: ["pivot", "pipeline"],
  },
  // MIR-018 (Apr 28 / Day 16, done): mid-market law discovery
  {
    number: 18,
    identifier: "MIR-018",
    title: "Discovery call — mid-market law cluster",
    description:
      "30-person law firm cluster. Compliance-grade document extraction. Validates Clearview-style motion at higher volume.",
    status: "done",
    priority: "medium",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(15).getTime() + 14 * 3_600_000),
    completedAt: new Date(day(15).getTime() + 15 * 3_600_000),
    cancelledAt: null,
    labels: ["pivot", "pipeline", "pro-services"],
  },
  // MIR-019 (Apr 29 / Day 17, done): Pivot decision — pro-services
  {
    number: 19,
    identifier: "MIR-019",
    title: "Pivot decision — professional services wedge",
    description:
      "Captured in company_memory (see decision row, Apr 30). Pivoting wedge to professional services (legal, PE, insurance). Killing manufacturing prospects in pipeline.",
    status: "done",
    priority: "high",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(16).getTime() + 17 * 3_600_000),
    completedAt: ist(2026, 4, 30, 14, 22),
    cancelledAt: null,
    labels: ["pivot", "pro-services", "internal"],
  },
  // MIR-020 (Apr 30 / Day 18, done): Theo prompt update
  {
    number: 20,
    identifier: "MIR-020",
    title: "Theo — update prompt template for pro-services positioning",
    description:
      "Maya created the issue. Anita actioned: swapped Theo's promptTemplate from manufacturing-default to pro-services-emphasising compliance/document-extraction. Captured in agent_config_revisions.",
    status: "done",
    priority: "high",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: "MAYA",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(17).getTime() + 11 * 3_600_000),
    completedAt: ist(2026, 4, 30, 14, 22),
    cancelledAt: null,
    labels: ["pivot", "pro-services", "internal"],
  },
  // MIR-021 (May 1 / Day 19, done): Iris May retainer — Northwood
  {
    number: 21,
    identifier: "MIR-021",
    title: "Northwood Dental — May retainer summary",
    description:
      "Iris drafted Northwood Dental May summary: 287 intake forms processed, 2,140 reminders sent. June scope: add insurance pre-authorization assistant.",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-northwood-2026-05-01",
    createdAt: ist(2026, 5, 1, 9, 0),
    completedAt: ist(2026, 5, 1, 9, 8),
    cancelledAt: null,
    labels: ["client", "finance", "recurring"],
  },
  // MIR-022 (May 1, done): Iris May Bake House (revised w/ payment ask)
  {
    number: 22,
    identifier: "MIR-022",
    title: "Bake House — May retainer summary (revised with payment ask)",
    description:
      "Iris drafted Bake House summary; Anita revised to include line asking about the overdue April payment. Approved after revision.",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-bakehouse-2026-05-01",
    createdAt: ist(2026, 5, 1, 9, 8),
    completedAt: ist(2026, 5, 1, 16, 12),
    cancelledAt: null,
    labels: ["client", "finance", "recurring", "urgent-attention"],
  },
  // MIR-023 (May 1, done): Iris May Clearview Legal
  {
    number: 23,
    identifier: "MIR-023",
    title: "Clearview Legal — May retainer summary",
    description:
      "Iris drafted Clearview Legal May summary including the expanded constitutional-law clause-extraction scope. 67 clauses extracted, 18 matter summaries.",
    status: "done",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-clearview-2026-05-01",
    createdAt: ist(2026, 5, 1, 9, 16),
    completedAt: ist(2026, 5, 1, 9, 24),
    cancelledAt: null,
    labels: ["client", "finance", "recurring", "pro-services"],
  },
  // MIR-024 (May 1, done): Iris first welcome — Shore Capital
  {
    number: 24,
    identifier: "MIR-024",
    title: "Shore Capital — first month welcome retainer summary",
    description:
      "First retainer summary for newly signed Shore Capital. Investment-memo formatter usage stats, onboarding milestones complete.",
    status: "done",
    priority: "medium",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "routine_execution",
    originId: "iris-retainer-summary-shorecapital-2026-05-01",
    createdAt: ist(2026, 5, 1, 9, 24),
    completedAt: ist(2026, 5, 1, 9, 32),
    cancelledAt: null,
    labels: ["client", "finance", "recurring"],
  },
  // MIR-025 (May 4 / Day 22, in_progress): SkyBridge cold outreach
  {
    number: 25,
    identifier: "MIR-025",
    title: "SkyBridge Insurance — cold outreach drafting",
    description:
      "Theo, with new pro-services prompt template, drafting opening pitch to SkyBridge. Warm intro from Northwood Dental — referencing in opener.",
    status: "in_progress",
    priority: "medium",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: "THEO",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(21).getTime() + 11 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["pipeline", "pro-services"],
  },
  // MIR-026 (May 5 / Day 23, blocked): Bake House chase
  {
    number: 26,
    identifier: "MIR-026",
    title: "Bake House — chase response to retainer summary",
    description:
      "Bake House did not respond to the May 1 retainer summary. Iris flagged as blocker; Maya elevated in daily brief. Blocked on Jason responding.",
    status: "blocked",
    priority: "high",
    assigneeAgent: "MAYA",
    assigneeUser: false,
    createdByAgent: "MAYA",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(22).getTime() + 8 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["client", "urgent-attention"],
  },
  // MIR-027 (May 6 / Day 24, done): Shore Capital decision outcome
  {
    number: 27,
    identifier: "MIR-027",
    title: "Shore Capital — decision outcome captured",
    description:
      "decision_outcomes cron fired (+14d from Apr 22 signing). Outcome: worked. Retainer running clean, onboarded in 4 days vs 7-day target.",
    status: "done",
    priority: "low",
    assigneeAgent: "MAYA",
    assigneeUser: false,
    createdByAgent: "MAYA",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(23).getTime() + 10 * 3_600_000),
    completedAt: new Date(day(23).getTime() + 10 * 3_600_000 + 5 * 60_000),
    cancelledAt: null,
    labels: ["client", "internal"],
  },
  // MIR-028 (May 8 / Day 26, in_review): Acme Retail proposal — cross-ref MIR-001
  {
    number: 28,
    identifier: "MIR-028",
    title: "Acme Retail — proposal draft for Anita's review",
    description:
      "Cross-references MIR-001 (Nasscom hot lead). Theo drafted full proposal evening of May 8: AI customer-support automation, ~$2K/mo + $3,500 setup. In Anita's review queue.",
    status: "in_review",
    priority: "high",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: "THEO",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(25).getTime() + 20 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["pipeline", "client"],
    withGoal: true,
    withProject: true,
  },
  // MIR-029 (May 9 / Day 27, todo): Fielding discovery prep
  {
    number: 29,
    identifier: "MIR-029",
    title: "Fielding Logistics — discovery call prep (May 14)",
    description:
      "Discovery call tomorrow. Theo to prep talking points: AI invoice reconciliation, ~$2K/mo, 120-staff freight. Compile background research from LinkedIn.",
    status: "todo",
    priority: "high",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(26).getTime() + 9 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["pipeline"],
  },
  // MIR-030 (May 9, todo): Fielding deck slides — blocked by MIR-029
  {
    number: 30,
    identifier: "MIR-030",
    title: "Fielding Logistics — prep deck slides",
    description:
      "5-slide deck for the discovery call: 1) intro, 2) invoice reconciliation pain points, 3) Mira approach, 4) case study (Clearview), 5) pricing + timeline.",
    status: "todo",
    priority: "medium",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(26).getTime() + 9 * 3_600_000 + 5 * 60_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["pipeline"],
  },
  // MIR-031 (May 10 / Day 28, todo): Bake House 2nd reminder — blocked by MIR-026
  {
    number: 31,
    identifier: "MIR-031",
    title: "Bake House — second payment reminder if no response by May 14",
    description:
      "Conditional: only send if Bake House hasn't responded to the first reminder by May 14. Iris drafts; Anita approves before send.",
    status: "todo",
    priority: "high",
    assigneeAgent: "IRIS",
    assigneeUser: false,
    createdByAgent: "IRIS",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(27).getTime() + 10 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["client", "finance", "urgent-attention"],
  },
  // MIR-032 (May 11 / Day 29, done): Anita approves payment reminder
  {
    number: 32,
    identifier: "MIR-032",
    title: "Approve payment reminder to Bake House",
    description:
      "Anita reviewed Iris's draft and approved. Reminder sent via Gmail. Awaiting Jason's response.",
    status: "done",
    priority: "high",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(28).getTime() + 11 * 3_600_000),
    completedAt: new Date(day(28).getTime() + 11 * 3_600_000 + 8 * 60_000),
    cancelledAt: null,
    labels: ["client", "finance"],
  },
  // MIR-033 (May 11, todo): Northwood June scope reply
  {
    number: 33,
    identifier: "MIR-033",
    title: "Northwood Dental — June scope confirmation reply",
    description:
      "Dr. Sharma asked about adding insurance pre-authorization assistant for June. Maya drafts reply confirming +$300/mo scope and timeline.",
    status: "todo",
    priority: "medium",
    assigneeAgent: "MAYA",
    assigneeUser: false,
    createdByAgent: "MAYA",
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(28).getTime() + 14 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["client"],
  },
  // MIR-034 (May 12 / Day 30, backlog): SkyBridge first call
  {
    number: 34,
    identifier: "MIR-034",
    title: "SkyBridge Insurance — schedule first call",
    description:
      "After cold outreach lands. Goal: 30-min discovery for week-of-May-19. Cal.com link to be sent in follow-up.",
    status: "backlog",
    priority: "low",
    assigneeAgent: "THEO",
    assigneeUser: false,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(29).getTime() + 16 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["pipeline"],
  },
  // MIR-035 (May 13 / Day 31, today, backlog): Q3 OKR refresh
  {
    number: 35,
    identifier: "MIR-035",
    title: "Q3 planning — refresh OKRs given pivot",
    description:
      "Pivot to pro-services is now baked into Q2. Q3 OKRs need a refresh: kill manufacturing-target language, double down on legal/PE/insurance wedge metrics.",
    status: "backlog",
    priority: "medium",
    assigneeAgent: null,
    assigneeUser: true,
    createdByAgent: null,
    originKind: "manual",
    originId: null,
    createdAt: new Date(day(30).getTime() + 7 * 3_600_000),
    completedAt: null,
    cancelledAt: null,
    labels: ["internal"],
  },
];

// ─── Sanity: assert distribution matches spec §3.5 ────────────────────────────
{
  const byStatus = issuePlans.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[seed-mira-labs-month1-issues] Plan: ${issuePlans.length} issues — ${JSON.stringify(byStatus)}`,
  );
  // Spec target: done 18 / in_progress 4 (existing MIR-005 adds 1 → 5 total) /
  // todo 4 (existing MIR-002,004 adds 2 → 6 total) / backlog 3 (existing MIR-003 → 4) /
  // in_review 1 / blocked 1 / cancelled 1. New rows only:
  // done=18, in_progress=1, todo=4, backlog=2, in_review=1, blocked=1, cancelled=1, in_review variants…
  // (We use 18/1/4/2/1/1/1/2 — variance per spec §3.5 "Total = 36. Acceptable variance.")
}

const agentMap = { MAYA, THEO, IRIS } as const;

const resolveAgentId = (
  key: "MAYA" | "THEO" | "IRIS" | null,
): string | null => (key === null ? null : agentMap[key].id);

// ─── Comments plan (spec §3.8 — 40 rows) ──────────────────────────────────────
type CommentPlan = {
  issueIdentifier: string;
  author: "ANITA" | "MAYA" | "THEO" | "IRIS";
  body: string;
  createdAt: Date;
};

const commentPlans: CommentPlan[] = [
  // MIR-019 (pivot) — 3 comments per spec
  {
    issueIdentifier: "MIR-019",
    author: "ANITA",
    body: "Two discovery calls this week, totally different verticals. Sat with this for 36 hours. Reasoning: Clearview already proves the pro-services motion works; manufacturing is a fresh GTM and I don't have warm references to lean on. I'd rather double down on what's working.",
    createdAt: new Date(day(16).getTime() + 20 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-019",
    author: "ANITA",
    body: "Killing Verdant Foods + the manufacturing prospect from Mon. Will update Theo's prompt tomorrow morning.",
    createdAt: new Date(day(16).getTime() + 21 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-019",
    author: "ANITA",
    body: "Captured the full reasoning in company_memory (pinned decision row, Apr 30). This is the inflection point.",
    createdAt: ist(2026, 4, 30, 14, 30),
  },
  // MIR-012 Shore Capital proposal — Theo + Anita
  {
    issueIdentifier: "MIR-012",
    author: "THEO",
    body: "Drafted; 412 words; pricing $1,000/mo + $2,500 setup; awaiting your review.",
    createdAt: new Date(day(7).getTime() + 11 * 3_600_000 + 10 * 60_000),
  },
  {
    issueIdentifier: "MIR-012",
    author: "ANITA",
    body: "Good — bump setup to $3K. They've got budget. Otherwise approve as-is.",
    createdAt: new Date(day(7).getTime() + 14 * 3_600_000),
  },
  // MIR-022 Bake House revised retainer
  {
    issueIdentifier: "MIR-022",
    author: "ANITA",
    body: "Add a line asking about the overdue payment — I want to know if there's a problem before I just chase it.",
    createdAt: ist(2026, 5, 1, 11, 12),
  },
  {
    issueIdentifier: "MIR-022",
    author: "IRIS",
    body: "Revised draft attached to approval. Tone is friendly; references the reorder script we shipped in March before the ask.",
    createdAt: ist(2026, 5, 1, 15, 30),
  },
  {
    issueIdentifier: "MIR-022",
    author: "ANITA",
    body: "Perfect. Approved.",
    createdAt: ist(2026, 5, 1, 16, 10),
  },
  // MIR-028 Acme Retail — in_review back-and-forth
  {
    issueIdentifier: "MIR-028",
    author: "THEO",
    body: "Drafted proposal. 540 words. $2K/mo retainer + $3,500 setup. 4-week audit phase scoped.",
    createdAt: new Date(day(25).getTime() + 20 * 3_600_000 + 30 * 60_000),
  },
  {
    issueIdentifier: "MIR-028",
    author: "ANITA",
    body: "Strong opener. Tighten the audit phase — 3 weeks not 4. They've got Q3 OKR pressure.",
    createdAt: new Date(day(26).getTime() + 10 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-028",
    author: "THEO",
    body: "Revised. 3-week audit, kept the rest. v2 attached.",
    createdAt: new Date(day(26).getTime() + 11 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-028",
    author: "ANITA",
    body: "One more — soften the conditional language in scope #3. 'Will deliver' not 'aim to deliver.' They want confidence.",
    createdAt: new Date(day(29).getTime() + 22 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-028",
    author: "THEO",
    body: "Done — v3 attached. Ready to send when you give the green light.",
    createdAt: new Date(day(29).getTime() + 22 * 3_600_000 + 30 * 60_000),
  },
  // MIR-026 Bake House blocker
  {
    issueIdentifier: "MIR-026",
    author: "MAYA",
    body: "Bake House silent on the May 1 retainer summary. 2nd time this quarter — potential churn signal. Surfacing in tomorrow's brief.",
    createdAt: new Date(day(22).getTime() + 8 * 3_600_000 + 5 * 60_000),
  },
  {
    issueIdentifier: "MIR-026",
    author: "ANITA",
    body: "Noted. Let's give it 3 more days before the formal reminder. Don't want to panic them.",
    createdAt: new Date(day(22).getTime() + 9 * 3_600_000),
  },
  {
    issueIdentifier: "MIR-026",
    author: "MAYA",
    body: "Still no response. Iris is queuing the payment-reminder draft.",
    createdAt: new Date(day(27).getTime() + 8 * 3_600_000),
  },
  // MIR-015 Verdant Foods cancellation
  {
    issueIdentifier: "MIR-015",
    author: "THEO",
    body: "OpenAI 429 on draft attempt. Retrying with backoff.",
    createdAt: new Date(day(11).getTime() + 13 * 3_600_000 + 5 * 60_000),
  },
  {
    issueIdentifier: "MIR-015",
    author: "ANITA",
    body: "Cancel this. Killing manufacturing prospects per Apr 30 pivot decision.",
    createdAt: ist(2026, 4, 30, 14, 25),
  },
  // MIR-011 Clearview scope expansion
  {
    issueIdentifier: "MIR-011",
    author: "THEO",
    body: "Drafted scope-expansion reply. +$800/mo for constitutional-law clause extraction. Tone: collaborative, refs the existing matter-summary cadence.",
    createdAt: new Date(day(4).getTime() + 14 * 3_600_000 + 10 * 60_000),
  },
  {
    issueIdentifier: "MIR-011",
    author: "ANITA",
    body: "Good. Sent.",
    createdAt: new Date(day(4).getTime() + 15 * 3_600_000),
  },
  // MIR-014 Shore Capital signed
  {
    issueIdentifier: "MIR-014",
    author: "ANITA",
    body: "Signed at full rate. Onboarding starts May 1 — kick-off call already booked.",
    createdAt: new Date(day(10).getTime() + 15 * 3_600_000 + 30 * 60_000),
  },
  // MIR-027 Shore Capital outcome captured
  {
    issueIdentifier: "MIR-027",
    author: "MAYA",
    body: "decision_outcomes row inserted; status=worked; founder note: 'Signed at full rate. Retainer running cleanly. Onboarding took 4 days vs target 7.'",
    createdAt: new Date(day(23).getTime() + 10 * 3_600_000 + 2 * 60_000),
  },
  // MIR-020 Theo prompt update
  {
    issueIdentifier: "MIR-020",
    author: "MAYA",
    body: "Surfaced this in daily brief — Theo's pre-pivot drafts are now off-brand for the pro-services positioning. Recommending prompt update.",
    createdAt: new Date(day(17).getTime() + 11 * 3_600_000 + 5 * 60_000),
  },
  {
    issueIdentifier: "MIR-020",
    author: "ANITA",
    body: "Done. New promptTemplate emphasises compliance/document-extraction. Captured in agent_config_revisions.",
    createdAt: ist(2026, 4, 30, 14, 22),
  },
  // MIR-008 Clearview April retainer
  {
    issueIdentifier: "MIR-008",
    author: "IRIS",
    body: "April clause extractions: 47. Matter summaries: 12. Drafted.",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000 + 4 * 60_000),
  },
  {
    issueIdentifier: "MIR-008",
    author: "ANITA",
    body: "Approved as-is.",
    createdAt: new Date(day(2).getTime() + 20 * 3_600_000 + 30 * 60_000),
  },
  // MIR-009 Bake House April retainer
  {
    issueIdentifier: "MIR-009",
    author: "IRIS",
    body: "April: 6 locations, 0 stockouts, ~12h manual work avoided. Drafted.",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000 + 12 * 60_000),
  },
  {
    issueIdentifier: "MIR-009",
    author: "ANITA",
    body: "Approved.",
    createdAt: new Date(day(2).getTime() + 20 * 3_600_000 + 32 * 60_000),
  },
  // MIR-010 Northwood April retainer
  {
    issueIdentifier: "MIR-010",
    author: "IRIS",
    body: "April: 247 intake forms, 1,840 reminders sent. Drafted.",
    createdAt: new Date(day(2).getTime() + 9 * 3_600_000 + 20 * 60_000),
  },
  {
    issueIdentifier: "MIR-010",
    author: "ANITA",
    body: "Approved. Iris caught the missing line about June availability — nice.",
    createdAt: new Date(day(2).getTime() + 20 * 3_600_000 + 35 * 60_000),
  },
  // MIR-021 Northwood May retainer
  {
    issueIdentifier: "MIR-021",
    author: "IRIS",
    body: "May: 287 intake forms, 2,140 reminders sent. June scope: insurance pre-auth assistant. Drafted.",
    createdAt: ist(2026, 5, 1, 9, 4),
  },
  // MIR-023 Clearview May retainer
  {
    issueIdentifier: "MIR-023",
    author: "IRIS",
    body: "May: 67 clauses extracted (constitutional-law expansion in flight), 18 matter summaries. Drafted.",
    createdAt: ist(2026, 5, 1, 9, 20),
  },
  // MIR-024 Shore Capital welcome retainer
  {
    issueIdentifier: "MIR-024",
    author: "IRIS",
    body: "First-month welcome: investment-memo formatter usage = 8 memos, onboarding milestones 4/4 complete.",
    createdAt: ist(2026, 5, 1, 9, 28),
  },
  // MIR-025 SkyBridge cold outreach (in_progress)
  {
    issueIdentifier: "MIR-025",
    author: "THEO",
    body: "Pro-services-flavored opener. Anchoring on the Northwood ref. Draft 1 in progress.",
    createdAt: new Date(day(21).getTime() + 11 * 3_600_000 + 30 * 60_000),
  },
  // MIR-029 Fielding discovery prep
  {
    issueIdentifier: "MIR-029",
    author: "THEO",
    body: "Pulling 5y of LinkedIn signal on Fielding ops team. Will have prep notes by tomorrow morning.",
    createdAt: new Date(day(26).getTime() + 9 * 3_600_000 + 30 * 60_000),
  },
  // MIR-031 Bake House 2nd reminder conditional
  {
    issueIdentifier: "MIR-031",
    author: "IRIS",
    body: "Conditional draft prepared. Will send only if no response by May 14 EOD IST.",
    createdAt: new Date(day(27).getTime() + 10 * 3_600_000 + 10 * 60_000),
  },
  // MIR-033 Northwood June scope reply
  {
    issueIdentifier: "MIR-033",
    author: "MAYA",
    body: "Drafting reply. +$300/mo for insurance pre-auth scope. Will queue approval for review.",
    createdAt: new Date(day(28).getTime() + 14 * 3_600_000 + 10 * 60_000),
  },
  // MIR-035 Q3 OKR refresh
  {
    issueIdentifier: "MIR-035",
    author: "ANITA",
    body: "Q3 OKR refresh: drop manufacturing-target language, double down on legal/PE/insurance metrics. Will block off 2h Friday.",
    createdAt: new Date(day(30).getTime() + 7 * 3_600_000 + 5 * 60_000),
  },
  // MIR-013 Shore proposal sent
  {
    issueIdentifier: "MIR-013",
    author: "ANITA",
    body: "Sent. Reply expected within 48h.",
    createdAt: new Date(day(8).getTime() + 11 * 3_600_000 + 5 * 60_000),
  },
  // MIR-016 Maya brief flagged Verdant
  {
    issueIdentifier: "MIR-016",
    author: "MAYA",
    body: "Flagged Theo's overnight OpenAI 429 on Verdant Foods proposal. Anita retried manually — succeeded.",
    createdAt: new Date(day(11).getTime() + 7 * 3_600_000 + 35 * 60_000),
  },
  // MIR-032 Bake House payment reminder approved
  {
    issueIdentifier: "MIR-032",
    author: "ANITA",
    body: "Approved. Don't send for 30 min — want to check the dunning tone one more time.",
    createdAt: new Date(day(28).getTime() + 11 * 3_600_000 + 4 * 60_000),
  },
];

// Verify comment count
if (commentPlans.length !== 40) {
  console.warn(
    `[seed-mira-labs-month1-issues] Comment plan length=${commentPlans.length} (spec target=40). Continuing.`,
  );
}

// ─── Relations plan (spec §3.10 — 6 rows, type=blocks) ────────────────────────
type RelationPlan = {
  issueIdentifier: string; // dependent
  relatedIssueIdentifier: string; // dependency (blocker)
};

// `issue_relations.type = 'blocks'` semantics: `issue blocks relatedIssue`
// (issue is the dependency; relatedIssue is the dependent). So for
// "X is blocked by Y", emit { issueIdentifier: Y, relatedIssueIdentifier: X }.
const relationPlans: RelationPlan[] = [
  // MIR-031 (2nd reminder) blocked by MIR-026 (chase response)
  { issueIdentifier: "MIR-026", relatedIssueIdentifier: "MIR-031" },
  // MIR-029 (Fielding prep) blocks MIR-030 (slides)
  { issueIdentifier: "MIR-029", relatedIssueIdentifier: "MIR-030" },
  // MIR-020 (Theo prompt update) blocks MIR-025 (SkyBridge cold outreach)
  { issueIdentifier: "MIR-020", relatedIssueIdentifier: "MIR-025" },
  // MIR-019 (pivot decision) blocks MIR-020 (Theo prompt update)
  { issueIdentifier: "MIR-019", relatedIssueIdentifier: "MIR-020" },
  // MIR-017 + MIR-018 (the two discovery calls) blocked MIR-019 (pivot)
  { issueIdentifier: "MIR-017", relatedIssueIdentifier: "MIR-019" },
  { issueIdentifier: "MIR-018", relatedIssueIdentifier: "MIR-019" },
];

// ─── Main transaction ─────────────────────────────────────────────────────────
const summary = {
  labelsInserted: 0,
  issuesInserted: 0,
  commentsInserted: 0,
  issueLabelsInserted: 0,
  relationsInserted: 0,
  executionRunsLinked: 0,
};

await db.transaction(async (tx) => {
  // ─── 1. labels ──────────────────────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-issues] labels…");

  // Idempotent insert via onConflictDoNothing on (company_id, name) UNIQUE.
  await tx
    .insert(labels)
    .values(
      labelDefs.map((l) => ({
        companyId: MIRA,
        name: l.name,
        color: l.color,
      })),
    )
    .onConflictDoNothing({ target: [labels.companyId, labels.name] });

  // Re-read to get IDs (whether we inserted or not).
  const labelRows = await tx
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(eq(labels.companyId, MIRA));
  const labelIdByName = new Map<string, string>();
  for (const lr of labelRows) labelIdByName.set(lr.name, lr.id);
  summary.labelsInserted = labelRows.length;
  console.log(
    `[seed-mira-labs-month1-issues] labels: ${labelRows.length} total in DB for Mira.`,
  );

  // ─── 2. issues ──────────────────────────────────────────────────────────────
  console.log(
    `[seed-mira-labs-month1-issues] issues: inserting ${issuePlans.length} rows (MIR-006..MIR-035)…`,
  );

  // Check which identifiers already exist so re-run is a strict no-op.
  const existingIdentRows = await tx
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, MIRA),
        inArray(
          issues.identifier,
          issuePlans.map((p) => p.identifier),
        ),
      ),
    );
  const existingIdent = new Map<string, string>();
  for (const r of existingIdentRows) {
    if (r.identifier) existingIdent.set(r.identifier, r.id);
  }

  const issueIdByIdentifier = new Map<string, string>();
  // Pre-populate with already-existing IDs (so downstream comments/labels still
  // attach correctly on re-run after a partial failure).
  for (const [ident, id] of existingIdent) {
    issueIdByIdentifier.set(ident, id);
  }

  for (const p of issuePlans) {
    if (existingIdent.has(p.identifier)) continue;

    const assigneeAgentId = resolveAgentId(p.assigneeAgent);
    const createdByAgentId = resolveAgentId(p.createdByAgent);

    // execution_run_id linking: every done issue with an agent assignee links
    // to a succeeded heartbeat_run on the same calendar day (IST). For Iris
    // routine_execution issues, the link is preferred; for others, best-effort.
    let executionRunId: string | null = null;
    if (p.status === "done" && assigneeAgentId) {
      const linkDay = p.completedAt ?? p.createdAt;
      executionRunId = pickRunFor(assigneeAgentId, linkDay);
      if (executionRunId) summary.executionRunsLinked++;
    }

    const createdAt = clampToRunNow(p.createdAt);
    const completedAt = p.completedAt
      ? clampToRunNow(
          p.completedAt.getTime() < createdAt.getTime()
            ? createdAt
            : p.completedAt,
        )
      : null;
    const cancelledAt = p.cancelledAt
      ? clampToRunNow(
          p.cancelledAt.getTime() < createdAt.getTime()
            ? createdAt
            : p.cancelledAt,
        )
      : null;

    const [row] = await tx
      .insert(issues)
      .values({
        companyId: MIRA,
        projectId: p.withProject ? Q2_PROJECT : null,
        goalId: p.withGoal ? GOAL_10K_MRR : null,
        title: p.title,
        description: p.description,
        status: p.status,
        priority: p.priority,
        assigneeAgentId: assigneeAgentId,
        assigneeUserId: p.assigneeUser ? ANITA_AUTH_UID : null,
        executionRunId: executionRunId,
        createdByAgentId: createdByAgentId,
        createdByUserId: p.assigneeUser && !createdByAgentId ? ANITA_AUTH_UID : null,
        issueNumber: p.number,
        identifier: p.identifier,
        originKind: p.originKind,
        originId: p.originId,
        startedAt: p.status === "done" || p.status === "in_progress" || p.status === "in_review" || p.status === "blocked" ? createdAt : null,
        completedAt: completedAt,
        cancelledAt: cancelledAt,
        createdAt: createdAt,
        updatedAt: completedAt ?? cancelledAt ?? createdAt,
      })
      .onConflictDoNothing({ target: issues.identifier })
      .returning({ id: issues.id, identifier: issues.identifier });

    if (row?.id) {
      issueIdByIdentifier.set(p.identifier, row.id);
      summary.issuesInserted++;
    } else {
      // Re-fetch — onConflictDoNothing path
      const refetch = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, MIRA),
            eq(issues.identifier, p.identifier),
          ),
        );
      if (refetch[0]?.id) issueIdByIdentifier.set(p.identifier, refetch[0].id);
    }
  }

  console.log(
    `[seed-mira-labs-month1-issues] issues: inserted ${summary.issuesInserted} new, ${existingIdent.size} pre-existing (idempotent).`,
  );

  // ─── 3. issue_labels (~50 rows per spec §3.9) ───────────────────────────────
  console.log("[seed-mira-labs-month1-issues] issue_labels…");

  // Build the full set of (issue, label) pairs from each issue's labels[].
  const labelPairs: Array<{
    issueId: string;
    labelId: string;
  }> = [];
  for (const p of issuePlans) {
    const issueId = issueIdByIdentifier.get(p.identifier);
    if (!issueId) {
      console.warn(
        `[seed-mira-labs-month1-issues] No issueId for ${p.identifier}, skipping labels`,
      );
      continue;
    }
    for (const labelName of p.labels) {
      const labelId = labelIdByName.get(labelName);
      if (!labelId) {
        console.warn(
          `[seed-mira-labs-month1-issues] Unknown label "${labelName}" on ${p.identifier}, skipping`,
        );
        continue;
      }
      labelPairs.push({ issueId, labelId });
    }
  }

  if (labelPairs.length > 0) {
    // Insert in chunks; primary key is (issueId, labelId), so onConflictDoNothing
    // on the PK handles idempotency.
    const CHUNK = 100;
    for (let i = 0; i < labelPairs.length; i += CHUNK) {
      const slice = labelPairs.slice(i, i + CHUNK);
      await tx
        .insert(issueLabels)
        .values(
          slice.map((p) => ({
            issueId: p.issueId,
            labelId: p.labelId,
            companyId: MIRA,
          })),
        )
        .onConflictDoNothing();
    }
  }

  // Count after — re-query to be exact, scoped to the issues we just touched.
  const issueIds = [...issueIdByIdentifier.values()];
  if (issueIds.length > 0) {
    const linkedRows = await tx
      .select({
        issueId: issueLabels.issueId,
        labelId: issueLabels.labelId,
      })
      .from(issueLabels)
      .where(
        and(
          eq(issueLabels.companyId, MIRA),
          inArray(issueLabels.issueId, issueIds),
        ),
      );
    summary.issueLabelsInserted = linkedRows.length;
  }
  console.log(
    `[seed-mira-labs-month1-issues] issue_labels: ${summary.issueLabelsInserted} pairs linked to new issues.`,
  );

  // ─── 4. issue_comments (40 rows) ─────────────────────────────────────────────
  console.log(
    `[seed-mira-labs-month1-issues] issue_comments: inserting ${commentPlans.length} rows…`,
  );

  // Idempotency strategy: there's no UNIQUE on issue_comments, so we natural-key
  // dedup by (companyId, issueId, body, createdAt) before inserting. This makes
  // re-runs a no-op for the deterministic plan.
  const existingComments = issueIds.length > 0
    ? await tx
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, MIRA),
            inArray(issueComments.issueId, issueIds),
          ),
        )
    : [];
  const existingCommentKey = new Set<string>(
    existingComments.map(
      (c) =>
        `${c.issueId}::${c.body}::${c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt)}`,
    ),
  );

  const commentRows: Array<{
    companyId: string;
    issueId: string;
    authorAgentId: string | null;
    authorUserId: string | null;
    body: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  for (const c of commentPlans) {
    const issueId = issueIdByIdentifier.get(c.issueIdentifier);
    if (!issueId) {
      console.warn(
        `[seed-mira-labs-month1-issues] No issueId for comment target ${c.issueIdentifier}, skipping`,
      );
      continue;
    }
    const createdAt = clampToRunNow(c.createdAt);
    const key = `${issueId}::${c.body}::${createdAt.toISOString()}`;
    if (existingCommentKey.has(key)) continue;
    existingCommentKey.add(key);

    const authorAgentId =
      c.author === "ANITA" ? null : resolveAgentId(c.author);
    const authorUserId = c.author === "ANITA" ? ANITA_AUTH_UID : null;

    commentRows.push({
      companyId: MIRA,
      issueId,
      authorAgentId,
      authorUserId,
      body: c.body,
      createdAt,
      updatedAt: createdAt,
    });
  }

  if (commentRows.length > 0) {
    const CHUNK = 50;
    for (let i = 0; i < commentRows.length; i += CHUNK) {
      await tx.insert(issueComments).values(commentRows.slice(i, i + CHUNK));
    }
  }
  summary.commentsInserted = commentRows.length;
  console.log(
    `[seed-mira-labs-month1-issues] issue_comments: inserted ${summary.commentsInserted} new (${existingComments.length} pre-existing).`,
  );

  // ─── 5. issue_relations (6 rows, type=blocks) ───────────────────────────────
  console.log("[seed-mira-labs-month1-issues] issue_relations…");

  const relationRows: Array<{
    companyId: string;
    issueId: string;
    relatedIssueId: string;
    type: "blocks";
    createdByUserId: string;
  }> = [];

  for (const r of relationPlans) {
    const issueId = issueIdByIdentifier.get(r.issueIdentifier);
    const relatedIssueId = issueIdByIdentifier.get(r.relatedIssueIdentifier);
    if (!issueId || !relatedIssueId) {
      console.warn(
        `[seed-mira-labs-month1-issues] Missing issue for relation ${r.issueIdentifier} → ${r.relatedIssueIdentifier}, skipping`,
      );
      continue;
    }
    relationRows.push({
      companyId: MIRA,
      issueId,
      relatedIssueId,
      type: "blocks",
      createdByUserId: ANITA_AUTH_UID,
    });
  }

  if (relationRows.length > 0) {
    // UNIQUE: (companyId, issueId, relatedIssueId, type) → onConflictDoNothing.
    await tx
      .insert(issueRelations)
      .values(relationRows)
      .onConflictDoNothing({
        target: [
          issueRelations.companyId,
          issueRelations.issueId,
          issueRelations.relatedIssueId,
          issueRelations.type,
        ],
      });
  }

  // Count the resulting rows (idempotent count, not delta).
  if (issueIds.length > 0) {
    const relRows = await tx
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, MIRA),
          inArray(issueRelations.issueId, issueIds),
        ),
      );
    summary.relationsInserted = relRows.length;
  }
  console.log(
    `[seed-mira-labs-month1-issues] issue_relations: ${summary.relationsInserted} edges anchored to new issues.`,
  );

  // ─── 6. Emit issues.json for downstream waves ───────────────────────────────
  const issuesJson: Record<string, string> = {};
  for (const [ident, id] of issueIdByIdentifier) {
    issuesJson[ident] = id;
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
        "[seed-mira-labs-month1-issues] No .planning/loop-2026-05-13-04 dir found above cwd — skipping issues.json write.",
      );
    } else {
      const outPath = `${base}/.planning/loop-2026-05-13-04/seeded-ids/issues.json`;
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(issuesJson, null, 2));
      console.log(
        `[seed-mira-labs-month1-issues] Wrote ${Object.keys(issuesJson).length} issue IDs → ${outPath}`,
      );
    }
  } catch (e) {
    console.warn(
      `[seed-mira-labs-month1-issues] Could not write issues.json (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});

// ─── End-of-run summary ───────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-issues] Inserted / linked:
  labels                : ${summary.labelsInserted} (total in DB for Mira)
  issues                : ${summary.issuesInserted} new
  issue_comments        : ${summary.commentsInserted} new
  issue_labels          : ${summary.issueLabelsInserted} pairs linked
  issue_relations       : ${summary.relationsInserted} edges
  execution_run_id linked: ${summary.executionRunsLinked}
`);

// Silence intentionally-unused helpers under TS strict mode.
void companies;
void addHours;
void pad3;

process.exit(0);
