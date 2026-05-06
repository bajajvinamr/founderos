/**
 * Wave 17A — Daily Digest cron.
 *
 * Every `tickIntervalMs` (default 15 min) the scheduler:
 *
 *   1. Loads every active `company_memberships` row where `digestEnabled=true`.
 *   2. For each row, computes the current local hour in `digestTimezone`.
 *   3. If the local hour equals `digestHourLocal` AND the last send was on a
 *      different local date, the digest is eligible.
 *   4. Builds the digest via `buildDailyDigest`. If the builder returns
 *      `null` (no signal), we skip delivery entirely — but we still record
 *      `digestLastSentAt` so we don't re-check the same user every tick today.
 *   5. Otherwise, dispatch the email via the Resend-backed EmailSender and
 *      stamp `digestLastSentAt`.
 *
 * Idempotency: `digestLastSentAt` is the source of truth. Two independent
 * processes would race on the `update`; the later one will fail silently
 * (its read-compare will no longer match), but the earlier one delivers.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { authUsers, companyMemberships } from "@founderos/db";
import { buildDailyDigest, hourInTimezone } from "./daily-digest.js";
import type { EmailSender } from "./email-sender.js";
import { logger } from "../middleware/logger.js";
import { runCronTick } from "../lib/cron-tick.js";

const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1_000;

export interface DailyDigestCronOptions {
  db: Db;
  emailSender: EmailSender;
  publicUrl?: string;
  tickIntervalMs?: number;
  /** Overrides `now` — test hook. */
  clock?: () => Date;
}

export interface DailyDigestCron {
  start(): void;
  stop(): void;
  /** Run a single tick immediately — primarily for tests. */
  tick(): Promise<{ eligible: number; sent: number; skipped: number }>;
}

export function createDailyDigestCron(opts: DailyDigestCronOptions): DailyDigestCron {
  const {
    db,
    emailSender,
    publicUrl,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    clock = () => new Date(),
  } = opts;

  const log = logger.child({ service: "daily-digest-cron" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;

  async function tick(): Promise<{ eligible: number; sent: number; skipped: number }> {
    if (inFlight) {
      log.debug("skipping digest tick — previous still running");
      return { eligible: 0, sent: 0, skipped: 0 };
    }
    inFlight = true;
    const now = clock();

    let eligible = 0;
    let sent = 0;
    let skipped = 0;

    try {
      // Only consider user-shaped principals; agents don't receive email digests.
      const memberships = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.status, "active"),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.digestEnabled, true),
          ),
        );

      if (memberships.length === 0) {
        return { eligible: 0, sent: 0, skipped: 0 };
      }

      // Bulk-load emails for all candidate users in one round-trip.
      const userIds = [...new Set(memberships.map((m) => m.principalId))];
      const userRows = userIds.length > 0
        ? await db
          .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
        : [];
      const userById = new Map(userRows.map((r) => [r.id, r]));

      for (const m of memberships) {
        const user = userById.get(m.principalId);
        if (!user?.email) {
          skipped++;
          continue;
        }

        const tz = m.digestTimezone || "UTC";
        const targetHour = m.digestHourLocal ?? 8;
        const currentLocalHour = hourInTimezone(now, tz);
        if (currentLocalHour !== targetHour) {
          continue;
        }

        // Idempotency: skip if we already sent for *today* in the user's tz.
        if (m.digestLastSentAt && sameLocalDate(m.digestLastSentAt, now, tz)) {
          continue;
        }

        eligible++;

        try {
          const digest = await buildDailyDigest(db, m.companyId, m.principalId, {
            publicUrl,
            now,
            timezone: tz,
          });

          if (!digest) {
            // No signal → don't send (empty digest is a bug, not a feature),
            // but stamp lastSentAt so we don't re-evaluate this membership
            // every tick until the hour rolls over.
            await db
              .update(companyMemberships)
              .set({ digestLastSentAt: now, updatedAt: now })
              .where(eq(companyMemberships.id, m.id));
            skipped++;
            continue;
          }

          const result = await emailSender.send({
            to: user.email,
            subject: digest.subject,
            text: digest.text,
            html: digest.html,
          });

          if (!result.ok) {
            log.warn(
              { companyId: m.companyId, userId: m.principalId, error: result.error },
              "daily digest send failed",
            );
            skipped++;
            continue;
          }

          await db
            .update(companyMemberships)
            .set({ digestLastSentAt: now, updatedAt: now })
            .where(eq(companyMemberships.id, m.id));

          sent++;
        } catch (err) {
          log.error(
            {
              companyId: m.companyId,
              userId: m.principalId,
              err: err instanceof Error ? err.message : String(err),
            },
            "daily digest build/send threw",
          );
          skipped++;
        }
      }

      return { eligible, sent, skipped };
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    // PR-5 (council 2026-05-07 P1): wrap in runCronTick so logs from inside
    // tick() carry a cron requestId/traceId/actor and any uncaught throw
    // routes to Sentry via captureServerError instead of being swallowed.
    timer = setInterval(() => {
      void runCronTick("daily-digest", tick);
    }, tickIntervalMs);
    // Don't block Node shutdown on this timer in tests / short-lived scripts.
    timer.unref?.();
    log.info({ tickIntervalMs }, "daily digest cron started");
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

/**
 * Return true when both instants fall on the same calendar date in the given
 * IANA timezone. Used to enforce "once per local day" delivery.
 */
function sameLocalDate(a: Date, b: Date, tz: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(a) === fmt.format(b);
}
