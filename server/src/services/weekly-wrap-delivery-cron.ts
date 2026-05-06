/**
 * Wave 18B — Weekly Wrap delivery cron.
 *
 * Ticks hourly. For each company with a Slack integration connected OR at
 * least one active member with `digestEnabled=true`, we check whether it is
 * Friday hour=17 in the primary timezone of the company. The timezone is
 * inferred from the first active member's `digestTimezone` (defaulting to
 * `UTC` if there are no members).
 *
 * On a matching tick we:
 *   1. Call `generateWeeklyWrap` (idempotent via the UNIQUE
 *      (companyId, weekEndingAt) index).
 *   2. Post to Slack via `postWeeklyWrapToSlack` (the 17B poster handles
 *      integration / channel / permission gating).
 *   3. Email every active member whose `digestEnabled=true`.
 *
 * Idempotency: we never duplicate the wrap because the generator short-circuits
 * on the unique key. We never double-email because we stamp `deliveredToEmailAt`
 * on the wrap row the first time all configured members have been notified.
 *
 * Errors are logged and swallowed — a single bad tick never stops the timer.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  authUsers,
  companies,
  companyMemberships,
  integrations,
  weeklyWraps,
} from "@founderos/db";
import type { EmailSender } from "./email-sender.js";
import { generateWeeklyWrap, type AnthropicCaller } from "./weekly-wrap-generator.js";
import { postWeeklyWrapToSlack } from "./weekly-wrap-poster.js";
import { hourInTimezone } from "./daily-digest.js";
import { logger } from "../middleware/logger.js";
import { runCronTick } from "../lib/cron-tick.js";

const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour
const TARGET_HOUR_LOCAL = 17; // 5pm local
const FRIDAY = 5;

export interface WeeklyWrapCronOptions {
  db: Db;
  emailSender: EmailSender;
  publicUrl?: string;
  tickIntervalMs?: number;
  /** Test hook — overrides the wall clock. */
  clock?: () => Date;
  /** Test hook — overrides the Anthropic caller end-to-end. */
  callAnthropic?: AnthropicCaller;
}

export interface WeeklyWrapCron {
  start(): void;
  stop(): void;
  /** Run one tick immediately — returns counts for tests. */
  tick(): Promise<{ considered: number; generated: number; slackDelivered: number; emailDelivered: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CandidateCompany = {
  companyId: string;
  timezone: string;
  hasSlack: boolean;
  digestMembers: Array<{ userId: string; email: string | null }>;
};

/**
 * Compute the full set of companies eligible for delivery: those with a
 * Slack integration OR at least one digest-enabled active member. We collapse
 * duplicates and capture the first active member's timezone as the company's
 * "primary timezone".
 */
async function resolveCandidateCompanies(db: Db): Promise<CandidateCompany[]> {
  const slackRows = await db
    .select({ companyId: integrations.companyId })
    .from(integrations)
    .where(eq(integrations.kind, "slack"));
  const slackCompanyIds = new Set(slackRows.map((r) => r.companyId));

  const membershipRows = await db
    .select({
      companyId: companyMemberships.companyId,
      principalId: companyMemberships.principalId,
      principalType: companyMemberships.principalType,
      status: companyMemberships.status,
      digestEnabled: companyMemberships.digestEnabled,
      digestTimezone: companyMemberships.digestTimezone,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.principalType, "user"),
      ),
    );

  const byCompany = new Map<string, CandidateCompany>();
  for (const m of membershipRows) {
    const existing = byCompany.get(m.companyId);
    if (!existing) {
      byCompany.set(m.companyId, {
        companyId: m.companyId,
        timezone: m.digestTimezone || "UTC",
        hasSlack: slackCompanyIds.has(m.companyId),
        digestMembers: m.digestEnabled
          ? [{ userId: m.principalId, email: null }]
          : [],
      });
      continue;
    }
    if (m.digestEnabled) {
      existing.digestMembers.push({ userId: m.principalId, email: null });
    }
  }

  // Ensure Slack-only companies (no members at all) still show up.
  for (const companyId of slackCompanyIds) {
    if (!byCompany.has(companyId)) {
      byCompany.set(companyId, {
        companyId,
        timezone: "UTC",
        hasSlack: true,
        digestMembers: [],
      });
    }
  }

  const candidates = [...byCompany.values()].filter(
    (c) => c.hasSlack || c.digestMembers.length > 0,
  );

  // Bulk-load emails for digest recipients.
  const userIds = [
    ...new Set(candidates.flatMap((c) => c.digestMembers.map((m) => m.userId))),
  ];
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.id, userIds));
    const emailById = new Map(userRows.map((r) => [r.id, r.email]));
    for (const c of candidates) {
      for (const m of c.digestMembers) {
        m.email = emailById.get(m.userId) ?? null;
      }
    }
  }

  return candidates;
}

function dayOfWeekInTimezone(instant: Date, tz: string): number {
  // en-US "short" weekday → Sun=0..Sat=6
  const wk = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(instant);
  switch (wk) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWeeklyWrapDeliveryCron(
  opts: WeeklyWrapCronOptions,
): WeeklyWrapCron {
  const {
    db,
    emailSender,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    clock = () => new Date(),
    callAnthropic,
  } = opts;

  const log = logger.child({ service: "weekly-wrap-delivery-cron" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;

  async function tick(): Promise<{
    considered: number;
    generated: number;
    slackDelivered: number;
    emailDelivered: number;
  }> {
    if (inFlight) {
      log.debug("skipping tick — previous still running");
      return { considered: 0, generated: 0, slackDelivered: 0, emailDelivered: 0 };
    }
    inFlight = true;
    const now = clock();

    let considered = 0;
    let generated = 0;
    let slackDelivered = 0;
    let emailDelivered = 0;

    try {
      const candidates = await resolveCandidateCompanies(db);
      for (const c of candidates) {
        const weekday = dayOfWeekInTimezone(now, c.timezone);
        const hour = hourInTimezone(now, c.timezone);
        if (weekday !== FRIDAY || hour !== TARGET_HOUR_LOCAL) {
          continue;
        }
        considered++;

        try {
          const wrap = await generateWeeklyWrap(db, c.companyId, {
            now,
            callAnthropic,
          });
          if (!wrap.reused) generated++;

          // Load company name for email subject + Slack text.
          const [company] = await db
            .select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, c.companyId))
            .limit(1);
          const companyName = company?.name ?? "your company";

          // ── Slack ─────────────────────────────────────────────────────
          if (c.hasSlack) {
            const slackResult = await postWeeklyWrapToSlack({
              db,
              companyId: c.companyId,
              permissionLevel: "autonomous",
              text: wrap.text,
              blocks: wrap.slackBlocks,
            });
            if (
              slackResult.ok &&
              !slackResult.skipped &&
              slackResult.outcome.ok &&
              slackResult.outcome.status === "posted"
            ) {
              slackDelivered++;
              await db
                .update(weeklyWraps)
                .set({
                  deliveredToSlackAt: now,
                  slackChannelId: slackResult.outcome.channelId,
                })
                .where(eq(weeklyWraps.id, wrap.storedWrapId));
            }
          }

          // ── Email ─────────────────────────────────────────────────────
          let anyEmailSent = false;
          for (const member of c.digestMembers) {
            if (!member.email) continue;
            const send = await emailSender.send({
              to: member.email,
              subject: `Weekly wrap — ${companyName}`,
              text: wrap.text,
              html: wrap.html,
            });
            if (send.ok) {
              anyEmailSent = true;
              emailDelivered++;
            } else {
              log.warn(
                { companyId: c.companyId, userId: member.userId, error: send.error },
                "weekly wrap email failed",
              );
            }
          }
          if (anyEmailSent) {
            await db
              .update(weeklyWraps)
              .set({ deliveredToEmailAt: now })
              .where(eq(weeklyWraps.id, wrap.storedWrapId));
          }
        } catch (err) {
          log.error(
            {
              companyId: c.companyId,
              err: err instanceof Error ? err.message : String(err),
            },
            "weekly-wrap-delivery-cron: per-company tick failed",
          );
        }
      }

      return { considered, generated, slackDelivered, emailDelivered };
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    // PR-5 (council 2026-05-07 P1): runCronTick adds cron
    // requestId/traceId/actor to logs from inside tick() and routes
    // uncaught throws to Sentry via captureServerError.
    timer = setInterval(() => {
      void runCronTick("weekly-wrap-delivery", tick);
    }, tickIntervalMs);
    timer.unref?.();
    log.info({ tickIntervalMs }, "weekly-wrap-delivery-cron started");
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  return { start, stop, tick };
}
