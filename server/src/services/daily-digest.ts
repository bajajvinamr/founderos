/**
 * Wave 17A — Daily Digest builder.
 *
 * Assembles the morning email content for a single user+company tuple:
 *
 *   1. Up to 3 pending decisions (approvals with status=pending).
 *   2. The 5 most recent agent runs with status + timestamp.
 *   3. Any agents whose most recent heartbeat_runs entry in the last 24h
 *      failed — so the founder notices broken teammates the next morning.
 *   4. Yesterday's agent cost in cents.
 *
 * The builder returns `null` when there is *nothing* to report. Empty digests
 * are a bug, not a feature — the cron job must skip delivery in that case.
 *
 * Consumed by:
 *   - `daily-digest-cron.ts` — picks which users get a digest this tick.
 *   - `routes/digest.ts`      — `GET /api/digest/preview` for the UI.
 */

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@founderos/db";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  costEvents,
  heartbeatRuns,
} from "@founderos/db";
import {
  buildDailyDigestEmailHtml,
  buildDailyDigestEmailText,
  type DailyDigestEmailParams,
  type PendingDecisionSummary,
  type RecentRunSummary,
  type FailingAgentSummary,
} from "./email-templates.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildDailyDigestOptions {
  /** Base URL for deep links (e.g. https://app.founderos.ai). No trailing slash. */
  publicUrl?: string;
  /** Overrides `now` for deterministic testing. */
  now?: Date;
  /** Timezone for the email "date" line. Defaults to UTC. */
  timezone?: string;
}

export interface BuildDailyDigestResult {
  subject: string;
  html: string;
  text: string;
  /** The underlying counts — exposed so routes/cron can decide whether to send. */
  metrics: {
    pendingDecisions: number;
    agentActions24h: number;
    failingAgents: number;
    costYesterdayCents: number;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the UTC window covering the caller's `yesterday` in `tz`.
 * We convert by formatting `now` in the target zone, peeling off the Y-M-D,
 * then interpreting midnight..midnight as UTC instants via `Date.UTC` on the
 * local-zone offset. Close enough for aggregate daily cost — exact DST math
 * isn't necessary for a 24h rollup window.
 */
export function yesterdayWindow(now: Date, tz: string): { start: Date; end: Date } {
  // Format now in the target tz as YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = fmt.format(now); // e.g. "2026-04-21"
  const [yStr, mStr, dStr] = localDate.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);

  // Midnight local-of-tz today, expressed as a UTC instant by reversing the
  // observed offset for that wall-clock instant.
  const todayLocalAsIfUtc = Date.UTC(y, m - 1, d);
  const offsetMs = tzOffsetMs(new Date(todayLocalAsIfUtc), tz);
  const todayStart = new Date(todayLocalAsIfUtc - offsetMs);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  return { start: yesterdayStart, end: todayStart };
}

/**
 * Return the UTC offset (in ms) for a specific instant in a specific IANA tz.
 * Positive for zones east of UTC, negative for west.
 */
function tzOffsetMs(instant: Date, tz: string): number {
  // Format the instant as parts in the target zone, then reconstruct a "fake UTC"
  // timestamp; the difference is the offset.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    map.year!,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    (map.hour ?? 0) % 24,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return asUtc - instant.getTime();
}

/**
 * Return the current wall-clock hour (0–23) in the given IANA tz.
 */
export function hourInTimezone(instant: Date, tz: string): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(instant);
  // Intl sometimes returns "24" at midnight — normalize.
  const h = parseInt(hourStr, 10);
  if (Number.isNaN(h)) return 0;
  return h % 24;
}

/**
 * Format the caller's local date like "Tuesday, April 21".
 */
export function formatLocalDateLine(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}

// ---------------------------------------------------------------------------
// HMAC unsubscribe tokens
// ---------------------------------------------------------------------------

const UNSUBSCRIBE_VERSION = "v1";

/**
 * Sign an opaque unsubscribe token that ties a (userId, companyId) pair to the
 * instance's SECRETS_MASTER_KEY. Token shape:
 *
 *   base64url(`${version}.${userId}.${companyId}`) + "." + base64url(hmac)
 */
export function signUnsubscribeToken(
  userId: string,
  companyId: string,
  secret: string,
): string {
  const payload = `${UNSUBSCRIBE_VERSION}.${userId}.${companyId}`;
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): { userId: string; companyId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, mac] = parts as [string, string];

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const providedBuf = Buffer.from(mac, "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  try {
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const [version, userId, companyId] = payload.split(".");
    if (version !== UNSUBSCRIBE_VERSION) return null;
    if (!userId || !companyId) return null;
    return { userId, companyId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a daily digest for a single user+company pair. Returns `null` when
 * there's nothing worth sending (no pending decisions AND no agent activity
 * in the last 24h AND no failing agents AND zero cost yesterday).
 */
export async function buildDailyDigest(
  db: Db,
  companyId: string,
  userId: string,
  options: BuildDailyDigestOptions = {},
): Promise<BuildDailyDigestResult | null> {
  const now = options.now ?? new Date();
  const tz = options.timezone ?? "UTC";
  const publicUrl = (options.publicUrl ?? "").replace(/\/+$/, "");

  // Company context — used in subject line + header.
  const [company] = await db
    .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) return null;

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // ---- Pending decisions (up to 3) ----
  const decisionRows = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      createdAt: approvals.createdAt,
      payload: approvals.payload,
    })
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(3);

  const pendingDecisions: PendingDecisionSummary[] = decisionRows.map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : `${row.type} decision`;
    return {
      id: row.id,
      title,
      type: row.type,
      url: publicUrl ? `${publicUrl}/${company.issuePrefix}/approvals/${row.id}` : null,
      createdAt: row.createdAt,
    };
  });

  // Count *all* pending decisions so the subject line can say "5 decisions" even
  // when we only render 3.
  const pendingDecisionCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
  const pendingDecisionsTotal = Number(pendingDecisionCountRows[0]?.n ?? 0);

  // ---- Recent agent runs (5 most recent by startedAt) ----
  const recentRunRows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      error: heartbeatRuns.error,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.startedAt, twentyFourHoursAgo),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(5);

  // Agent-name lookup for the recent runs + failing-agents section.
  const agentIdSet = new Set<string>(recentRunRows.map((r) => r.agentId));

  // ---- Failing agents in the last 24h (unique) ----
  const failedRunRows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      error: heartbeatRuns.error,
      startedAt: heartbeatRuns.startedAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "failed"),
        gte(heartbeatRuns.startedAt, twentyFourHoursAgo),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt));

  for (const r of failedRunRows) agentIdSet.add(r.agentId);

  const agentIdList = [...agentIdSet];
  const agentRows = agentIdList.length > 0
    ? await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIdList))
    : [];
  const agentNameById = new Map<string, string>(agentRows.map((r) => [r.id, r.name]));

  const recentRuns: RecentRunSummary[] = recentRunRows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: agentNameById.get(r.agentId) ?? "Unknown agent",
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }));

  // Dedupe failing agents (keep first = most recent failure).
  const seenFailingAgents = new Set<string>();
  const failingAgents: FailingAgentSummary[] = [];
  for (const r of failedRunRows) {
    if (seenFailingAgents.has(r.agentId)) continue;
    seenFailingAgents.add(r.agentId);
    failingAgents.push({
      agentId: r.agentId,
      agentName: agentNameById.get(r.agentId) ?? "Unknown agent",
      lastFailureAt: r.startedAt,
      error: r.error,
    });
  }

  // ---- Agent cost yesterday (user-local calendar day) ----
  const { start: yStart, end: yEnd } = yesterdayWindow(now, tz);
  const costRows = await db
    .select({ totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, yStart),
        lt(costEvents.occurredAt, yEnd),
      ),
    );
  const costYesterdayCents = Number(costRows[0]?.totalCents ?? 0);

  // ---- Agent action count (activity_log rows in last 24h) ----
  const actionCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        gte(activityLog.createdAt, twentyFourHoursAgo),
      ),
    );
  const agentActions24h = Number(actionCountRows[0]?.n ?? 0);

  // ---- Empty digest gate ----
  if (
    pendingDecisionsTotal === 0 &&
    recentRuns.length === 0 &&
    failingAgents.length === 0 &&
    costYesterdayCents === 0 &&
    agentActions24h === 0
  ) {
    return null;
  }

  // ---- Build email envelope ----
  const manageUrl = publicUrl ? `${publicUrl}/settings/notifications` : "/settings/notifications";
  const unsubToken = signUnsubscribeToken(userId, companyId, resolveUnsubscribeSecret());
  const unsubscribeUrl = publicUrl
    ? `${publicUrl}/api/digest/unsubscribe/${unsubToken}`
    : `/api/digest/unsubscribe/${unsubToken}`;

  const params: DailyDigestEmailParams = {
    companyName: company.name,
    dateLine: formatLocalDateLine(now, tz),
    pendingDecisions,
    pendingDecisionsTotal,
    recentRuns,
    failingAgents,
    agentActions24h,
    costYesterdayCents,
    manageUrl,
    unsubscribeUrl,
  };

  const subject = buildSubjectLine({
    companyName: company.name,
    pendingDecisionsTotal,
    agentActions24h,
  });

  return {
    subject,
    html: buildDailyDigestEmailHtml(params),
    text: buildDailyDigestEmailText(params),
    metrics: {
      pendingDecisions: pendingDecisionsTotal,
      agentActions24h,
      failingAgents: failingAgents.length,
      costYesterdayCents,
    },
  };
}

function buildSubjectLine(input: {
  companyName: string;
  pendingDecisionsTotal: number;
  agentActions24h: number;
}): string {
  const bits: string[] = [];
  if (input.pendingDecisionsTotal > 0) {
    bits.push(`${input.pendingDecisionsTotal} decision${input.pendingDecisionsTotal === 1 ? "" : "s"}`);
  }
  if (input.agentActions24h > 0) {
    bits.push(`${input.agentActions24h} agent action${input.agentActions24h === 1 ? "" : "s"}`);
  }
  const summary = bits.length > 0 ? bits.join(", ") : "nothing urgent";
  return `Good morning — ${summary} at ${input.companyName}`;
}

/**
 * Resolve the HMAC secret for unsubscribe tokens. Prefers
 * `FOUNDEROS_SECRETS_MASTER_KEY`, then falls back to
 * `FOUNDEROS_DIGEST_SECRET`, and as a last resort a dev-only constant so
 * the test suite can exercise round-trips without env setup.
 */
export function resolveUnsubscribeSecret(): string {
  const master = process.env.FOUNDEROS_SECRETS_MASTER_KEY;
  if (master && master.trim().length > 0) return master.trim();
  const digestSecret = process.env.FOUNDEROS_DIGEST_SECRET;
  if (digestSecret && digestSecret.trim().length > 0) return digestSecret.trim();
  return "founderos-dev-digest-secret-do-not-ship";
}
