/**
 * Agent Reviews service.
 *
 * Generates and stores rolling monthly performance reviews per teammate.
 * generateMonthlyReview is idempotent per (agentId, monthOf).
 */

import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { agentReviews, agents, heartbeatRuns, issues, costEvents, activityLog } from "@founderos/db";
import type { AgentReview, AgentReviewRecommendation } from "@founderos/shared";
import { notFound } from "../errors.js";

function toReview(row: typeof agentReviews.$inferSelect): AgentReview {
  return {
    id: row.id,
    agentId: row.agentId,
    companyId: row.companyId,
    monthOf: row.monthOf,
    shiftsRun: row.shiftsRun,
    issuesClosed: row.issuesClosed,
    costCents: row.costCents,
    blockedIncidents: row.blockedIncidents,
    summaryMarkdown: row.summaryMarkdown,
    recommendation: row.recommendation as AgentReviewRecommendation,
    rationale: row.rationale,
    source: row.source as "auto" | "manual",
    generatedAt: row.generatedAt,
  };
}

function monthBounds(monthOfISO: string): { start: Date; end: Date } {
  const start = new Date(`${monthOfISO}T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

function monthName(monthOfISO: string): string {
  const d = new Date(`${monthOfISO}T12:00:00.000Z`);
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function computeRecommendation(issuesClosed: number, costCents: number): AgentReviewRecommendation {
  if (issuesClosed >= 5 && issuesClosed > 0 && costCents / issuesClosed < 5000) {
    return "promote";
  }
  if (issuesClosed >= 2) {
    return "keep";
  }
  if (issuesClosed < 2 && costCents > 10000) {
    return "let_go";
  }
  return "rebrief";
}

function computeRationale(
  recommendation: AgentReviewRecommendation,
  issuesClosed: number,
  costCents: number,
): string {
  switch (recommendation) {
    case "promote":
      return `Shipped ${issuesClosed} this month at ${formatCents(Math.round(costCents / issuesClosed))} per issue — pulling more than their weight.`;
    case "keep":
      return `Shipped ${issuesClosed} this month — doing the job.`;
    case "let_go":
      return `Only ${issuesClosed} shipped at ${formatCents(costCents)}/mo — consider offboarding or a sharp re-brief.`;
    case "rebrief":
      return `Only ${issuesClosed} shipped this month — they may need clearer direction or a smaller scope.`;
    default:
      return `${issuesClosed} issues closed this month.`;
  }
}

function buildSummaryMarkdown(
  agentName: string,
  monthOfISO: string,
  shiftsRun: number,
  issuesClosed: number,
  costCents: number,
  blockedIncidents: number,
  recommendation: AgentReviewRecommendation,
): string {
  const month = monthName(monthOfISO);
  const lines: string[] = [
    `Over ${month}, ${agentName} ran ${shiftsRun} work session${shiftsRun === 1 ? "" : "s"} and closed ${issuesClosed} issue${issuesClosed === 1 ? "" : "s"}.`,
    `Monthly spend was ${formatCents(costCents)}.`,
  ];

  if (blockedIncidents > 0) {
    lines.push(`They hit ${blockedIncidents} blocker${blockedIncidents === 1 ? "" : "s"}.`);
  }

  switch (recommendation) {
    case "promote":
      lines.push(`Strong output this month — ${agentName} is exceeding expectations and worth expanding their scope.`);
      break;
    case "keep":
      lines.push(`${agentName} is delivering consistently — keep the current brief going.`);
      break;
    case "let_go":
      lines.push(`High cost relative to output — consider offboarding or a sharp re-brief before next month.`);
      break;
    case "rebrief":
      lines.push(`Low output this month — ${agentName} may need clearer direction or a narrower scope to ship more.`);
      break;
  }

  return lines.join("\n");
}

export function agentReviewsService(db: Db) {
  async function list(
    companyId: string,
    opts?: { agentId?: string; limit?: number },
  ): Promise<AgentReview[]> {
    const conditions = [eq(agentReviews.companyId, companyId)];
    if (opts?.agentId) {
      conditions.push(eq(agentReviews.agentId, opts.agentId));
    }

    const rows = await db
      .select()
      .from(agentReviews)
      .where(and(...conditions))
      .orderBy(desc(agentReviews.monthOf))
      .limit(opts?.limit ?? 50);

    return rows.map(toReview);
  }

  async function getLatest(agentId: string): Promise<AgentReview | null> {
    const rows = await db
      .select()
      .from(agentReviews)
      .where(eq(agentReviews.agentId, agentId))
      .orderBy(desc(agentReviews.monthOf))
      .limit(1);

    return rows[0] ? toReview(rows[0]) : null;
  }

  async function generateMonthlyReview(agentId: string, monthOfISO: string): Promise<AgentReview> {
    // Resolve agent to get companyId and name
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");

    const { start, end } = monthBounds(monthOfISO);

    // 1. shifts_run = heartbeat_run rows for this agent in the month
    const shiftsRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          gte(heartbeatRuns.createdAt, start),
          lt(heartbeatRuns.createdAt, end),
        ),
      );
    const shiftsRun = shiftsRows.length;

    // 2. issues_closed = issues assigned to this agent, status done, updated in month
    const closedRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.assigneeAgentId, agentId),
          eq(issues.status, "done"),
          gte(issues.updatedAt, start),
          lt(issues.updatedAt, end),
        ),
      );
    const issuesClosed = closedRows.length;

    // 3. cost_cents = sum of cost events for this agent in the month
    const costRows = await db
      .select({ cost: costEvents.costCents })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.agentId, agentId),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      );
    const costCents = costRows.reduce((sum, r) => sum + r.cost, 0);

    // 4. blocked_incidents = activity events with action like %blocked% or %error%
    const blockedRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.agentId, agentId),
          gte(activityLog.createdAt, start),
          lt(activityLog.createdAt, end),
          or(ilike(activityLog.action, "%blocked%"), ilike(activityLog.action, "%error%")),
        ),
      );
    const blockedIncidents = blockedRows.length;

    // 5. Compute recommendation
    const recommendation = computeRecommendation(issuesClosed, costCents);

    // 6. Rationale
    const rationale = computeRationale(recommendation, issuesClosed, costCents);

    // 7. Summary
    const agentName = agent.name;
    const summaryMarkdown = buildSummaryMarkdown(
      agentName,
      monthOfISO,
      shiftsRun,
      issuesClosed,
      costCents,
      blockedIncidents,
      recommendation,
    );

    // 8. Upsert on (agentId, monthOf)
    const [existing] = await db
      .select()
      .from(agentReviews)
      .where(
        and(
          eq(agentReviews.agentId, agentId),
          sql`${agentReviews.monthOf}::text = ${monthOfISO}`,
        ),
      );

    const now = new Date();

    if (existing) {
      const [updated] = await db
        .update(agentReviews)
        .set({
          shiftsRun,
          issuesClosed,
          costCents,
          blockedIncidents,
          summaryMarkdown,
          recommendation,
          rationale,
          source: "auto",
          generatedAt: now,
        })
        .where(eq(agentReviews.id, existing.id))
        .returning();
      return toReview(updated);
    }

    const [created] = await db
      .insert(agentReviews)
      .values({
        agentId,
        companyId: agent.companyId,
        monthOf: monthOfISO,
        shiftsRun,
        issuesClosed,
        costCents,
        blockedIncidents,
        summaryMarkdown,
        recommendation,
        rationale,
        source: "auto",
        generatedAt: now,
      })
      .returning();

    return toReview(created);
  }

  async function createManual(
    agentId: string,
    input: {
      summaryMarkdown: string;
      recommendation: AgentReviewRecommendation;
      rationale: string;
      monthOf?: string;
    },
  ): Promise<AgentReview> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");

    // Default monthOf to first of current month
    const now = new Date();
    const monthOf =
      input.monthOf ??
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

    // Upsert so manual can overwrite an existing record for the same month
    const [existing] = await db
      .select()
      .from(agentReviews)
      .where(
        and(
          eq(agentReviews.agentId, agentId),
          sql`${agentReviews.monthOf}::text = ${monthOf}`,
        ),
      );

    if (existing) {
      const [updated] = await db
        .update(agentReviews)
        .set({
          summaryMarkdown: input.summaryMarkdown,
          recommendation: input.recommendation,
          rationale: input.rationale,
          source: "manual",
          generatedAt: now,
        })
        .where(eq(agentReviews.id, existing.id))
        .returning();
      return toReview(updated);
    }

    const [created] = await db
      .insert(agentReviews)
      .values({
        agentId,
        companyId: agent.companyId,
        monthOf,
        shiftsRun: 0,
        issuesClosed: 0,
        costCents: 0,
        blockedIncidents: 0,
        summaryMarkdown: input.summaryMarkdown,
        recommendation: input.recommendation,
        rationale: input.rationale,
        source: "manual",
        generatedAt: now,
      })
      .returning();

    return toReview(created);
  }

  return {
    list,
    getLatest,
    generateMonthlyReview,
    createManual,
  };
}
