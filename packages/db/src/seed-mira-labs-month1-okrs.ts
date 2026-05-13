/**
 * seed-mira-labs-month1-okrs.ts — Wave 5 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent E):
 *   - goals     : 5 new rows (child goals under existing 3 + 1 top-level pivot)
 *   - projects  : 4 new rows (April Retainer Ops / Q2 Pro-Services GTM /
 *                 Brand & Content / Onboarding Automation Internal)
 *   - project_goals : up to 6 link rows wiring projects to relevant goals
 *
 * Schema reality vs spec language:
 *   The spec mentions goal columns like priority, target_value, current_value,
 *   target_date, due_date, owner_user_id — none of these exist on the actual
 *   goals table. The current schema is: id / companyId / title / description
 *   / level / status / parentId / ownerAgentId. Rich detail is therefore put
 *   in the description string. Owner is an agent id (Maya/Theo/Iris), not a
 *   user id. status is constrained at the application layer to
 *   GOAL_STATUSES = [planned|active|achieved|cancelled]; we map narrative
 *   status to that enum:
 *      "in_progress" -> "active"
 *      "done"        -> "achieved"
 *      "blocked"     -> "active"   (block detail captured in description)
 *      "todo"        -> "planned"
 *
 *   Same for projects: PROJECT_STATUSES = [backlog|planned|in_progress|
 *   completed|cancelled].
 *
 * Coherence guarantees:
 *   - Existing 3 goals + 1 project are NOT modified.
 *   - 4 new goals carry parent_id pointing at the matching pre-seeded parent
 *     (looked up at runtime by title substring). One top-level pivot goal
 *     has parent_id = null.
 *   - project_goals link rows wire each new project to its relevant goals;
 *     skipped silently if either side wasn't found.
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-okrs.ts
 *
 * Re-run safety: every insert is preceded by a natural-key existence check
 * (goals by (companyId, title); projects by (companyId, name); project_goals
 * by its composite primary key). The whole script wraps in a transaction.
 * Re-running is a strict no-op once the target row counts are met.
 *
 * Hard limits (council carry-over):
 *   - NEVER touch instance_api_keys (council condition #4)
 *   - NEVER set companies.is_demo = true (DB trigger 0109 rejects)
 *   - NO Stripe API calls
 *   - DO NOT modify the existing 3 goals or 1 project
 *   - All timestamps in the past (cap at "now" = 2026-05-13 IST)
 */

import { sql, eq, and } from "drizzle-orm";
import { createDb } from "./client.js";
import { companies, agents, goals, projects, projectGoals } from "./schema/index.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-okrs] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-okrs] DATABASE_URL is required");
  process.exit(1);
}

const PERSONA_TAG = "mira-labs-dogfood";

// ─── Time helpers ─────────────────────────────────────────────────────────────
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

// ─── DB setup ────────────────────────────────────────────────────────────────
const db = createDb(DATABASE_URL);

console.log(
  "[seed-mira-labs-month1-okrs] Looking up Mira Labs company + agents…",
);

const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];

if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-okrs] Mira Labs company not found. Run scripts/seed-mira-labs.ts (Wave 0) first.",
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
  `[seed-mira-labs-month1-okrs] MIRA=${MIRA} MAYA=${MAYA.id} THEO=${THEO.id} IRIS=${IRIS.id}`,
);

// ─── Resolve pre-seeded parent goals by title substring ──────────────────────
const existingGoals = await db
  .select({ id: goals.id, title: goals.title })
  .from(goals)
  .where(eq(goals.companyId, MIRA));

if (existingGoals.length < 3) {
  console.error(
    `[seed-mira-labs-month1-okrs] Expected ≥3 pre-seeded goals; found ${existingGoals.length}. Run Wave 0 first.`,
  );
  process.exit(1);
}

function findGoalIdBySubstring(needle: string): string | null {
  const n = needle.toLowerCase();
  return (
    existingGoals.find((g) => g.title.toLowerCase().includes(n))?.id ?? null
  );
}

const GOAL_10K_MRR_ID = findGoalIdBySubstring("10k mrr");
const GOAL_PROPOSAL_VELOCITY_ID = findGoalIdBySubstring(
  "proposal drafting time",
);
const GOAL_ZERO_CHURN_ID = findGoalIdBySubstring("zero churn");

console.log(
  `[seed-mira-labs-month1-okrs] Parents: 10K-MRR=${GOAL_10K_MRR_ID ?? "<missing>"} proposal=${GOAL_PROPOSAL_VELOCITY_ID ?? "<missing>"} churn=${GOAL_ZERO_CHURN_ID ?? "<missing>"}`,
);

// ─── New goals to insert (5 rows) ────────────────────────────────────────────
//
// status enum mapping vs spec narrative:
//   in_progress -> "active"
//   done        -> "achieved"
//   blocked     -> "active" (blocker captured in description)
//
// GOAL_LEVELS: company | team | agent | task
//   - "company" reserved for the existing 3 top-level goals.
//   - "team" for cross-agent group goals (e.g. weekly wraps cadence).
//   - "agent" for single-agent OKRs (Theo proposal count, Iris invoice hygiene,
//      Anita discovery-call cadence).

interface GoalSeed {
  title: string;
  description: string;
  level: "company" | "team" | "agent" | "task";
  status: "planned" | "active" | "achieved" | "cancelled";
  parentId: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const newGoals: GoalSeed[] = [
  // 1. Theo — proposal volume in Q2. Parent = $10K MRR.
  //    Status active (in_progress); 8 of 12 drafted by Day 30.
  {
    title: "Theo — Draft 12 client proposals in Q2",
    description:
      "Theo generates first-draft proposals from discovery transcripts; Anita reviews + approves. Progress: 8/12 drafted (Shore Capital, Verdant Foods [cancelled], Clearview scope-expansion reply, SkyBridge cold pitch, Acme Retail, plus Fielding prep × 2 and 2 internal templating drafts). Target date 2026-06-30.",
    level: "agent",
    status: "active",
    parentId: GOAL_10K_MRR_ID,
    ownerAgentId: THEO.id,
    // Created Day 4 (Apr 16) — first week after agents proved useful.
    createdAt: ist(2026, 4, 16, 9, 30),
    updatedAt: ist(2026, 5, 12, 18, 10),
  },

  // 2. Iris — invoice hygiene. Parent = $10K MRR (cashflow protects growth
  //    runway). Status blocked → mapped to "active"; block detail in body.
  {
    title: "Iris — Zero overdue invoices for 2 consecutive weeks",
    description:
      "BLOCKED as of 2026-05-08: Bake House $1,200 May invoice is 5 days overdue and Jason has not responded to the retainer-summary email. Iris flagged via insight + daily-brief blocker; Anita approved a payment-reminder draft on 2026-05-11. Resume countdown once Bake House clears. Target: 14 consecutive overdue-free days by 2026-06-30.",
    level: "agent",
    status: "active",
    parentId: GOAL_10K_MRR_ID,
    ownerAgentId: IRIS.id,
    createdAt: ist(2026, 4, 16, 10, 0),
    updatedAt: ist(2026, 5, 8, 19, 15),
  },

  // 3. Maya — weekly-wrap delivery cadence. Parent = zero-churn (weekly
  //    visibility surfaces at-risk customers). Status done -> achieved
  //    since Week 4 wrap fired Friday May 8.
  {
    title: "Maya — 4 weekly wraps delivered by May 13",
    description:
      "Maya synthesises Slack #mira-team and Gmail traffic into the Friday 17:00 IST weekly wrap and pushes to Slack (+ email when enabled). Delivered: Wrap #1 (Apr 17), #2 (Apr 24), #3 (May 1), #4 (May 8). All 4 succeeded over Slack; emails for #1+#2 succeeded, #3+#4 paused at founder's request. Achieved 2026-05-08.",
    level: "team",
    status: "achieved",
    parentId: GOAL_ZERO_CHURN_ID,
    ownerAgentId: MAYA.id,
    createdAt: ist(2026, 4, 17, 9, 0),
    updatedAt: ist(2026, 5, 8, 17, 5),
  },

  // 4. Anita — discovery-call cadence. Owner is logically Anita but the
  //    schema only supports agent owner; assigning to Theo (BD) since
  //    Theo follows up on every call. Parent = $10K MRR.
  {
    title: "Anita — Hold 3 discovery calls per week",
    description:
      "Pipeline throughput is bottlenecked by discovery-call count, not proposal drafting (insight #9, Day 9, acted-on). Anita targets 3 calls/week with new prospects. Week 1: 0 (setup), Week 2: 1 (Shore Capital), Week 3: 2 (manufacturing prospect + mid-market legal cluster — the pivot week), Week 4: 1 (SkyBridge), Week 5: 1 booked (Fielding tomorrow). Cumulative 5 / 12 target. Status: active (in_progress).",
    level: "agent",
    status: "active",
    parentId: GOAL_10K_MRR_ID,
    // Owner falls to Theo since Anita-as-user isn't expressible in this
    // schema (ownerAgentId only references agents.id).
    ownerAgentId: THEO.id,
    createdAt: ist(2026, 4, 22, 11, 0),
    updatedAt: ist(2026, 5, 12, 20, 0),
  },

  // 5. Top-level pivot goal — committed on Day 18 (Apr 30) per spec §2
  //    Week 3. Done -> achieved. Parent = null (new top-level goal that
  //    sits alongside the existing 3 company goals).
  {
    title: "Q2 — Pro-services wedge committed",
    description:
      "Pivoted wedge to professional services (legal / PE / insurance) on 2026-04-30. Killed manufacturing prospects (Verdant Foods cancelled). Theo's prompt template updated to emphasise compliance + document-extraction angle (agent_config_revisions row created same day). Decision captured as a pinned company_memory entry. Status: achieved — the pivot is committed and reflected in all downstream agent prompts + outreach.",
    level: "company",
    status: "achieved",
    parentId: null,
    // Owner: Maya since she synthesised the recommendation that drove the pivot.
    ownerAgentId: MAYA.id,
    createdAt: ist(2026, 4, 30, 14, 22),
    updatedAt: ist(2026, 4, 30, 18, 0),
  },
];

// ─── New projects to insert (4 rows) ─────────────────────────────────────────
//
// projects.status enum: backlog | planned | in_progress | completed | cancelled
// projects.targetDate is a date (YYYY-MM-DD). Color = hex for UI swatch.

interface ProjectSeed {
  name: string;
  description: string;
  status: "backlog" | "planned" | "in_progress" | "completed" | "cancelled";
  leadAgentId: string | null;
  // Link the project to its primary goal via the legacy single FK; the
  // project_goals link table below carries the M:N relationship.
  primaryGoalId: string | null;
  /** Comma-separated additional goal-id links via project_goals (M:N). */
  linkedGoalIds: Array<string | null>;
  targetDate: string | null;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

const newProjects: ProjectSeed[] = [
  // 1. April Retainer Operations — covers Iris monthly summaries +
  //    invoice hygiene over the April cycle. Apr work done → completed.
  {
    name: "April Retainer Operations",
    description:
      "Iris-led monthly cycle for April: 4 retainer summaries (Northwood Dental, Bake House, Clearview Legal, Shore Capital welcome) + invoice tracking + Friday finance digests. April closed clean with all 4 summaries approved; Bake House May invoice slipped into Week 5 follow-up. Lead: Iris.",
    status: "completed",
    leadAgentId: IRIS.id,
    primaryGoalId: GOAL_ZERO_CHURN_ID,
    linkedGoalIds: [GOAL_ZERO_CHURN_ID, GOAL_10K_MRR_ID],
    targetDate: "2026-04-30",
    color: "#eab308", // yellow (finance)
    createdAt: ist(2026, 4, 14, 9, 0),
    updatedAt: ist(2026, 4, 30, 23, 30),
  },

  // 2. Q2 Pivot — Pro-Services GTM. Active project covering the wedge
  //    refresh + SkyBridge cold outreach + pro-services-tilted prompts.
  {
    name: "Q2 Pivot — Pro-Services GTM",
    description:
      "Refresh outreach + positioning for the legal/PE/insurance wedge committed on 2026-04-30. Includes: Theo prompt swap (done, Day 18), SkyBridge cold pitch (in flight), kill manufacturing prospects (done — Verdant Foods cancelled), refresh proposal templates with compliance/document-extraction emphasis. Targets 2 new pro-services retainers signed by 2026-06-30. Lead: Theo.",
    status: "in_progress",
    leadAgentId: THEO.id,
    primaryGoalId: GOAL_10K_MRR_ID,
    linkedGoalIds: [GOAL_10K_MRR_ID, GOAL_PROPOSAL_VELOCITY_ID],
    targetDate: "2026-06-30",
    color: "#a855f7", // purple (pivot)
    createdAt: ist(2026, 4, 30, 14, 30),
    updatedAt: ist(2026, 5, 12, 19, 45),
  },

  // 3. Brand & Content Foundation. Earlier-stage (planned) — Anita has
  //    scheduled the "4h -> 8min" proposal-velocity LinkedIn post
  //    (insight #10, Day 8, status=open) but content cadence hasn't
  //    started in earnest.
  {
    name: "Brand & Content Foundation",
    description:
      "Stand up Mira Labs' content presence: LinkedIn cadence (Anita-voiced), case-study from Shore Capital signing + Clearview Legal scope-expansion, plus the '4h -> 8min proposal velocity' founder-note that insight #10 (Day 8) flagged. Buffer subscribed in April ($50). Status: planned — first post drafts not yet queued.",
    status: "planned",
    leadAgentId: THEO.id,
    primaryGoalId: GOAL_10K_MRR_ID,
    linkedGoalIds: [GOAL_10K_MRR_ID],
    targetDate: "2026-07-31",
    color: "#06b6d4", // cyan (content)
    createdAt: ist(2026, 4, 21, 11, 0),
    updatedAt: ist(2026, 5, 4, 10, 15),
  },

  // 4. Onboarding Automation Internal. Backlog — Anita's own product
  //    backlog of "what to wire next" for the agents (e.g. auto-Slack
  //    standup, auto-Stripe overdue chase). Not yet started.
  {
    name: "Onboarding Automation Internal",
    description:
      "Internal product backlog of agent automations Anita wants to ship for herself: auto Stripe overdue-chase loop (currently Iris flags + Anita approves; goal is zero-touch up to 7d overdue), Maya auto-posting weekend brief summary, Theo proposal-template gallery with 5 verticals. Status: backlog — design only, no work scheduled yet.",
    status: "backlog",
    leadAgentId: MAYA.id,
    primaryGoalId: GOAL_PROPOSAL_VELOCITY_ID,
    linkedGoalIds: [GOAL_PROPOSAL_VELOCITY_ID, GOAL_ZERO_CHURN_ID],
    targetDate: "2026-09-30",
    color: "#6b7280", // gray (internal)
    createdAt: ist(2026, 5, 3, 21, 0),
    updatedAt: ist(2026, 5, 3, 21, 0),
  },
];

// ─── Main transaction ────────────────────────────────────────────────────────

const summary = {
  goalsInserted: 0,
  projectsInserted: 0,
  projectGoalLinksInserted: 0,
  goalsSkipped: 0,
  projectsSkipped: 0,
};

await db.transaction(async (tx) => {
  // ─── Insert goals ──────────────────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-okrs] goals…");

  const goalIdByTitle = new Map<string, string>();
  for (const g of existingGoals) {
    goalIdByTitle.set(g.title, g.id);
  }

  for (const g of newGoals) {
    // Idempotency: skip if a row with the same (companyId, title) already exists.
    const existing = await tx
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.companyId, MIRA), eq(goals.title, g.title)));
    if (existing.length > 0) {
      goalIdByTitle.set(g.title, existing[0]!.id);
      summary.goalsSkipped++;
      continue;
    }
    const inserted = await tx
      .insert(goals)
      .values({
        companyId: MIRA,
        title: g.title,
        description: g.description,
        level: g.level,
        status: g.status,
        parentId: g.parentId,
        ownerAgentId: g.ownerAgentId,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })
      .returning({ id: goals.id });
    if (inserted[0]) {
      goalIdByTitle.set(g.title, inserted[0].id);
      summary.goalsInserted++;
    }
  }

  // ─── Insert projects ───────────────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-okrs] projects…");

  const projectIdByName = new Map<string, string>();

  for (const p of newProjects) {
    const existing = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, MIRA), eq(projects.name, p.name)));
    if (existing.length > 0) {
      projectIdByName.set(p.name, existing[0]!.id);
      summary.projectsSkipped++;
      continue;
    }
    const inserted = await tx
      .insert(projects)
      .values({
        companyId: MIRA,
        goalId: p.primaryGoalId,
        name: p.name,
        description: p.description,
        status: p.status,
        leadAgentId: p.leadAgentId,
        targetDate: p.targetDate,
        color: p.color,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })
      .returning({ id: projects.id });
    if (inserted[0]) {
      projectIdByName.set(p.name, inserted[0].id);
      summary.projectsInserted++;
    }
  }

  // ─── project_goals link table (M:N) ────────────────────────────────────────
  // Wire each new project to its declared linkedGoalIds (deduplicated). Skip
  // any link row whose goal lookup fell through (null) or whose pair already
  // exists (composite PK).
  console.log("[seed-mira-labs-month1-okrs] project_goals…");

  for (const p of newProjects) {
    const projectId = projectIdByName.get(p.name);
    if (!projectId) continue;
    const distinctGoalIds = Array.from(
      new Set(p.linkedGoalIds.filter((id): id is string => id !== null)),
    );
    for (const goalId of distinctGoalIds) {
      // Idempotency on composite PK (projectId, goalId).
      const existing = await tx
        .select({ projectId: projectGoals.projectId })
        .from(projectGoals)
        .where(
          and(
            eq(projectGoals.projectId, projectId),
            eq(projectGoals.goalId, goalId),
          ),
        );
      if (existing.length > 0) continue;
      await tx.insert(projectGoals).values({
        projectId,
        goalId,
        companyId: MIRA,
        createdAt: RUN_NOW,
        updatedAt: RUN_NOW,
      });
      summary.projectGoalLinksInserted++;
    }
  }
});

// ─── End-of-run summary ──────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-okrs] Inserted:
  goals               : ${summary.goalsInserted} (skipped existing: ${summary.goalsSkipped})
  projects            : ${summary.projectsInserted} (skipped existing: ${summary.projectsSkipped})
  project_goals links : ${summary.projectGoalLinksInserted}

Goal parent-child structure:
  (top-level)
    ├── "Hit $10K MRR by August 2026"         [pre-seed]
    │     ├── Theo — Draft 12 client proposals in Q2          [new, active]
    │     ├── Iris — Zero overdue invoices for 2 weeks        [new, active (blocked)]
    │     └── Anita — Hold 3 discovery calls per week         [new, active]
    ├── "Reduce proposal drafting time from 4h to 30min"      [pre-seed]
    ├── "Zero churn — all 4 retainers renewed through Q3"     [pre-seed]
    │     └── Maya — 4 weekly wraps delivered by May 13       [new, achieved]
    └── "Q2 — Pro-services wedge committed"                   [new, achieved]
`);

process.exit(0);
