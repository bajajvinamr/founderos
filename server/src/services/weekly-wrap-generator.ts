/**
 * Wave 18B — Weekly Wrap generator.
 *
 * Responsibilities:
 *   1. Aggregate the past 7 days of company signal:
 *        - issues shipped (status=done, completed within the window)
 *        - decisions approved (approvals with status=approved)
 *        - top activity highlights (recent activity_log rows)
 *        - metric deltas (spend from cost_events)
 *        - open blockers (active high/critical open issues)
 *   2. Ask Anthropic for a 3-paragraph narrative summary, using the instance's
 *      stored API key.
 *   3. Persist the result into `weekly_wraps` (idempotent per
 *      (companyId, weekEndingAt) via the unique index).
 *   4. Return the rendered payload — text + html + optional Slack blocks + the
 *      stored wrap id — for the delivery cron / on-demand route.
 *
 * Design notes:
 *   - Uses dependency injection for the Anthropic caller + key getter so tests
 *     can exercise the whole flow without hitting the network.
 *   - Mirrors the pattern in `conversation-extractor.ts` (same model, same
 *     version header, same 60s timeout).
 *   - The generator is the ONE place that decides what a wrap looks like. The
 *     cron + on-demand route are thin wrappers around it.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  activityLog,
  approvals,
  companies,
  costEvents,
  issues,
  weeklyWraps,
  type WeeklyWrapHighlight,
  type WeeklyWrapMetrics,
} from "@founderos/db";
import { instanceApiKeysService } from "./instance-api-keys.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const NARRATIVE_MODEL = "claude-sonnet-4-6";
const NARRATIVE_TIMEOUT_MS = 60_000;
const MAX_HIGHLIGHTS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GeneratedWeeklyWrap = {
  storedWrapId: string;
  /** Plain-text body for email + Slack fallback. */
  text: string;
  /** HTML body for email. */
  html: string;
  /** Optional Slack block payload for rich rendering. */
  slackBlocks?: unknown[];
  /** The 3-paragraph narrative returned by Claude. */
  narrative: string;
  highlights: WeeklyWrapHighlight[];
  metrics: WeeklyWrapMetrics;
  weekEndingAt: Date;
  /** True when the unique (companyId, weekEndingAt) row already existed. */
  reused: boolean;
};

export type AnthropicCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

export interface GenerateWeeklyWrapOptions {
  /** Overrides `now` for deterministic testing. */
  now?: Date;
  /** Explicit Friday-ending timestamp. When absent we derive from `now`. */
  weekEndingAt?: Date;
  /** Dependency injection — default wires to the instance-api-keys service. */
  getAnthropicKey?: () => Promise<string | null>;
  /** Dependency injection — default hits the Anthropic Messages API. */
  callAnthropic?: AnthropicCaller;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const WEEKLY_WRAP_SYSTEM_PROMPT =
  "You are the Chief of Staff drafting the weekly wrap for a founder. " +
  "Write 3 tight paragraphs: what shipped, what stalled, what to focus on " +
  "next week. No bullets, no headers in the body — just clean prose. " +
  "120-180 words total. Never use adjectives like 'amazing', 'crucial', " +
  "'robust'. Tone: direct, operator-to-operator.";

// ---------------------------------------------------------------------------
// Helpers — aggregation
// ---------------------------------------------------------------------------

type AggregateSignal = {
  shippedIssues: Array<{ id: string; title: string; identifier: string | null }>;
  approvedDecisions: Array<{ id: string; type: string; title: string | null }>;
  activityCount: number;
  topActivity: Array<{ action: string; entityType: string; createdAt: Date }>;
  openBlockers: Array<{ id: string; title: string; priority: string }>;
  spendCents: number;
  companyName: string;
};

async function aggregateWeek(
  db: Db,
  companyId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<AggregateSignal | null> {
  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company) return null;

  // Shipped issues — status=done and completedAt inside the window (falls back
  // to updatedAt for rows predating completedAt backfill).
  const shippedRows = await db
    .select({
      id: issues.id,
      title: issues.title,
      identifier: issues.identifier,
      completedAt: issues.completedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.status, "done")))
    .orderBy(desc(issues.updatedAt))
    .limit(50);

  const shippedIssues = shippedRows
    .filter((r) => {
      const ts = (r.completedAt ?? r.updatedAt).getTime();
      return ts >= windowStart.getTime() && ts < windowEnd.getTime();
    })
    .map((r) => ({ id: r.id, title: r.title, identifier: r.identifier }));

  // Approved decisions inside the window.
  const approvedRows = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      payload: approvals.payload,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.status, "approved"),
        gte(approvals.decidedAt, windowStart),
      ),
    )
    .orderBy(desc(approvals.decidedAt))
    .limit(25);

  const approvedDecisions = approvedRows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : null;
    return { id: r.id, type: r.type, title };
  });

  // Activity count + top activity rows.
  const activityRows = await db
    .select({
      action: activityLog.action,
      entityType: activityLog.entityType,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        gte(activityLog.createdAt, windowStart),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(200);

  const topActivity = activityRows.slice(0, 10);
  const activityCount = activityRows.length;

  // Open blockers — high/critical open issues regardless of age.
  const openIssues = await db
    .select({
      id: issues.id,
      title: issues.title,
      priority: issues.priority,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.companyId, companyId))
    .limit(200);

  const openBlockers = openIssues
    .filter(
      (r) =>
        r.status !== "done" &&
        r.status !== "cancelled" &&
        (r.priority === "critical" || r.priority === "high"),
    )
    .slice(0, 10);

  // Agent cost in the window.
  const costRows = await db
    .select({ costCents: costEvents.costCents, occurredAt: costEvents.occurredAt })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, windowStart),
      ),
    )
    .limit(1_000);

  const spendCents = costRows
    .filter((r) => r.occurredAt.getTime() < windowEnd.getTime())
    .reduce((sum, r) => sum + (r.costCents ?? 0), 0);

  return {
    shippedIssues,
    approvedDecisions,
    activityCount,
    topActivity,
    openBlockers,
    spendCents,
    companyName: company.name,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildUserPrompt(agg: AggregateSignal): string {
  const lines: string[] = [];
  lines.push(`Company: ${agg.companyName}`);
  lines.push("");
  lines.push(`## Shipped this week (${agg.shippedIssues.length})`);
  if (agg.shippedIssues.length === 0) {
    lines.push("- nothing marked done in the last 7 days");
  } else {
    for (const i of agg.shippedIssues.slice(0, 15)) {
      const id = i.identifier ? `[${i.identifier}] ` : "";
      lines.push(`- ${id}${i.title}`);
    }
  }
  lines.push("");
  lines.push(`## Decisions approved (${agg.approvedDecisions.length})`);
  if (agg.approvedDecisions.length === 0) {
    lines.push("- none this week");
  } else {
    for (const d of agg.approvedDecisions.slice(0, 10)) {
      lines.push(`- ${d.type}: ${d.title ?? "(no title)"}`);
    }
  }
  lines.push("");
  lines.push(
    `## Activity: ${agg.activityCount} events · spend $${(agg.spendCents / 100).toFixed(2)}`,
  );
  lines.push("");
  lines.push(`## Open blockers (${agg.openBlockers.length})`);
  if (agg.openBlockers.length === 0) {
    lines.push("- no high/critical items outstanding");
  } else {
    for (const b of agg.openBlockers) {
      lines.push(`- [${b.priority}] ${b.title}`);
    }
  }
  lines.push("");
  lines.push(
    "Draft the 3-paragraph narrative per the system prompt. Return ONLY the prose — no JSON, no headers.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default Anthropic caller
// ---------------------------------------------------------------------------

async function defaultCallAnthropic(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NARRATIVE_TIMEOUT_MS);
  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: NARRATIVE_MODEL,
        max_tokens: 1024,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic request failed (${response.status}): ${bodyText.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");

    if (!text.trim()) {
      throw new Error("Anthropic returned empty content");
    }
    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Highlight builder
// ---------------------------------------------------------------------------

function buildHighlights(agg: AggregateSignal): WeeklyWrapHighlight[] {
  const out: WeeklyWrapHighlight[] = [];
  for (const issue of agg.shippedIssues.slice(0, 4)) {
    const prefix = issue.identifier ? `${issue.identifier}: ` : "";
    out.push({
      type: "issue_shipped",
      title: `${prefix}${issue.title}`,
    });
  }
  for (const decision of agg.approvedDecisions.slice(0, 2)) {
    out.push({
      type: "decision_approved",
      title: decision.title ?? decision.type,
    });
  }
  for (const blocker of agg.openBlockers.slice(0, 2)) {
    out.push({
      type: "blocker",
      title: `[${blocker.priority}] ${blocker.title}`,
    });
  }
  return out.slice(0, MAX_HIGHLIGHTS);
}

// ---------------------------------------------------------------------------
// Rendered payload builders
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildText(args: {
  companyName: string;
  weekEndingAt: Date;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
}): string {
  const dateLine = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(args.weekEndingAt);
  const parts = [
    `Weekly wrap — ${args.companyName}`,
    `Week ending ${dateLine}`,
    "",
    args.narrative,
  ];
  if (args.highlights.length > 0) {
    parts.push("");
    parts.push("Highlights:");
    for (const h of args.highlights) {
      parts.push(`- ${h.title}`);
    }
  }
  return parts.join("\n");
}

function buildHtml(args: {
  companyName: string;
  weekEndingAt: Date;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
}): string {
  const dateLine = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(args.weekEndingAt);
  const paragraphs = args.narrative
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`)
    .join("\n");
  const highlightsHtml =
    args.highlights.length === 0
      ? ""
      : `<h3 style="font-size:14px;margin:20px 0 8px">Highlights</h3><ul style="padding-left:20px;margin:0">${args.highlights
          .map((h) => `<li>${escapeHtml(h.title)}</li>`)
          .join("")}</ul>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:640px;margin:0 auto;padding:24px">
  <p style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:0 0 6px">
    Weekly wrap · ${escapeHtml(args.companyName)}
  </p>
  <h2 style="font-size:20px;margin:0 0 16px">Week ending ${escapeHtml(dateLine)}</h2>
  ${paragraphs}
  ${highlightsHtml}
</body>
</html>`;
}

function buildSlackBlocks(args: {
  companyName: string;
  weekEndingAt: Date;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
}): unknown[] {
  const dateLine = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(args.weekEndingAt);
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Weekly wrap — ${args.companyName}`,
        emoji: false,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Week ending ${dateLine}` }],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: args.narrative.slice(0, 2900) },
    },
  ];
  if (args.highlights.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Highlights*\n" +
          args.highlights.map((h) => `• ${h.title}`).join("\n"),
      },
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Date math
// ---------------------------------------------------------------------------

/**
 * Given a reference instant, return the most recent Friday 23:59:59 UTC.
 * We use this as the deterministic "week_ending_at" key so the same local
 * Friday in any reasonable timezone maps to one UTC instant per wall-clock day.
 */
export function deriveWeekEnding(now: Date): Date {
  const copy = new Date(now.getTime());
  // Day index where Friday=5. We want the most-recent Friday at end-of-day UTC.
  const day = copy.getUTCDay();
  const daysSinceFriday = (day - 5 + 7) % 7; // 0 when today is Friday
  const fri = new Date(
    Date.UTC(
      copy.getUTCFullYear(),
      copy.getUTCMonth(),
      copy.getUTCDate() - daysSinceFriday,
      23,
      59,
      59,
      0,
    ),
  );
  return fri;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate (or reuse) the weekly wrap for `companyId`.
 *
 * Idempotency: if a row already exists for (companyId, weekEndingAt), we
 * return the stored narrative and mark `reused=true` — no second LLM call.
 */
export async function generateWeeklyWrap(
  db: Db,
  companyId: string,
  options: GenerateWeeklyWrapOptions = {},
): Promise<GeneratedWeeklyWrap> {
  const now = options.now ?? new Date();
  const weekEndingAt = options.weekEndingAt ?? deriveWeekEnding(now);
  const windowStart = new Date(weekEndingAt.getTime() - WEEK_MS);

  // ── Idempotent short-circuit ──
  const [existing] = await db
    .select()
    .from(weeklyWraps)
    .where(
      and(
        eq(weeklyWraps.companyId, companyId),
        eq(weeklyWraps.weekEndingAt, weekEndingAt),
      ),
    )
    .limit(1);

  if (existing) {
    const [company] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const companyName = company?.name ?? "Your company";
    const text = buildText({
      companyName,
      weekEndingAt,
      narrative: existing.narrative,
      highlights: existing.highlights,
    });
    const html = buildHtml({
      companyName,
      weekEndingAt,
      narrative: existing.narrative,
      highlights: existing.highlights,
    });
    const slackBlocks = buildSlackBlocks({
      companyName,
      weekEndingAt,
      narrative: existing.narrative,
      highlights: existing.highlights,
    });
    return {
      storedWrapId: existing.id,
      text,
      html,
      slackBlocks,
      narrative: existing.narrative,
      highlights: existing.highlights,
      metrics: existing.metrics,
      weekEndingAt,
      reused: true,
    };
  }

  // ── Aggregate signal ──
  const agg = await aggregateWeek(db, companyId, windowStart, weekEndingAt);
  if (!agg) {
    throw new Error(`Company not found: ${companyId}`);
  }

  // ── Resolve Anthropic caller ──
  const callAnthropic = options.callAnthropic ?? defaultCallAnthropic;
  const getAnthropicKey =
    options.getAnthropicKey ??
    (async () => instanceApiKeysService(db).getDecryptedKey("anthropic", "api"));

  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key configured for this instance — add one in Instance → Providers",
    );
  }

  // ── Call the model ──
  const userPrompt = buildUserPrompt(agg);
  const narrative = await callAnthropic({
    apiKey,
    systemPrompt: WEEKLY_WRAP_SYSTEM_PROMPT,
    userPrompt,
  });

  const highlights = buildHighlights(agg);
  const metrics: WeeklyWrapMetrics = {
    issuesShipped: agg.shippedIssues.length,
    decisionsApproved: agg.approvedDecisions.length,
    activityCount: agg.activityCount,
    openBlockers: agg.openBlockers.length,
    agentSpendCents: agg.spendCents,
  };

  // ── Persist. The unique index on (companyId, weekEndingAt) means a race
  // between two callers resolves to "first writer wins"; the loser catches
  // the unique-violation and re-reads the winning row so both callers get a
  // consistent view. ──
  let storedWrapId: string;
  try {
    const [row] = await db
      .insert(weeklyWraps)
      .values({
        companyId,
        weekEndingAt,
        narrative,
        highlights,
        metrics,
      })
      .returning({ id: weeklyWraps.id });
    storedWrapId = row.id;
  } catch (err) {
    logger.warn(
      { err, companyId, weekEndingAt },
      "weekly-wrap-generator: insert raced, re-reading",
    );
    const [racedRow] = await db
      .select({ id: weeklyWraps.id })
      .from(weeklyWraps)
      .where(
        and(
          eq(weeklyWraps.companyId, companyId),
          eq(weeklyWraps.weekEndingAt, weekEndingAt),
        ),
      )
      .limit(1);
    if (!racedRow) throw err;
    storedWrapId = racedRow.id;
  }

  const text = buildText({
    companyName: agg.companyName,
    weekEndingAt,
    narrative,
    highlights,
  });
  const html = buildHtml({
    companyName: agg.companyName,
    weekEndingAt,
    narrative,
    highlights,
  });
  const slackBlocks = buildSlackBlocks({
    companyName: agg.companyName,
    weekEndingAt,
    narrative,
    highlights,
  });

  return {
    storedWrapId,
    text,
    html,
    slackBlocks,
    narrative,
    highlights,
    metrics,
    weekEndingAt,
    reused: false,
  };
}
