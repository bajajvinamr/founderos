/**
 * recipient-materialization.ts — S4.8 prerequisite #195.
 *
 * Closes council 2026-05-06 finding #4: pre-compute the recipient list at
 * workflow_run CREATION time (not lazily at send time), with hard guarantees:
 *
 *   1. Cross-tenant safe: no recipient from outside the run's companyId.
 *   2. Empty-list rejected: don't create a run that targets zero recipients
 *      (silent no-op runs are an audit blackhole).
 *   3. Deduplicated: a contact appearing multiple times in the source events
 *      is collapsed to ONE recipient — prevents N×email_send for one user.
 *   4. Suppression-pre-filtered: contacts with an existing suppression for
 *      the target topic are dropped UPFRONT (uses #196 isSuppressed under
 *      the hood, batched).
 *   5. Capped: hard ceiling on recipient count per run (default 100).
 *      Larger cohorts must be split into multiple runs — protects the
 *      domain reputation gate (#199 rate limit) and keeps each run
 *      auditable.
 *   6. Email-shape validated: invalid emails are dropped (NOT errored) so
 *      one malformed payload doesn't poison the whole materialization.
 *
 * ## Design rationale: why pre-compute
 *
 * Lazy resolution at send time means the recipient list at approval time
 * differs from what actually gets emailed. Founder approves "13 at-risk
 * users", an hour later the cohort recomputes to 27 because more events
 * landed → 14 unexpected emails go out. Pre-computing freezes the cohort
 * at approval time; the founder sees and approves the same list that ships.
 */

import { customerEmailSuppressions } from "@founderos/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import type { SuppressionTopic } from "@founderos/db";
import { logger } from "../middleware/logger.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface RecipientCandidate {
  /** Contact email — will be normalized to lowercase + trimmed. */
  email: string;
  /** Optional displayed name; not validated. */
  name?: string;
  /** Optional foreign key tying back to the source row (PostHog distinctId, HubSpot id, etc). */
  externalId?: string;
  /** Free-form payload carried through to the workflow_run action.payload. */
  meta?: Record<string, unknown>;
}

export interface MaterializedRecipient {
  email: string; // lowercased
  name?: string;
  externalId?: string;
  meta?: Record<string, unknown>;
}

export type MaterializationFailure =
  | { reason: "empty_input"; companyId: string }
  | { reason: "all_dropped"; companyId: string; counts: DropCounts }
  | { reason: "exceeded_cap"; companyId: string; cap: number; received: number };

export type MaterializationResult =
  | {
      ok: true;
      companyId: string;
      topic: SuppressionTopic;
      recipients: MaterializedRecipient[];
      counts: DropCounts;
    }
  | { ok: false } & MaterializationFailure;

export interface DropCounts {
  /** Inputs received from the caller. */
  received: number;
  /** Dropped because email shape is invalid. */
  invalidEmail: number;
  /** Dropped during dedup. */
  duplicate: number;
  /** Dropped because contact has a suppression row for this topic. */
  suppressed: number;
  /** Dropped because we hit the cap (over-cap recipients are truncated, not silently kept). */
  overCap: number;
  /** Final count returned. */
  retained: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Default per-run recipient cap. Tunable via env override
 * `FOUNDEROS_RECIPIENT_CAP_<UPPER_SNAKE_TOPIC>`. 100 is intentionally tight —
 * the rate limiter (#199) caps at 50/day for churn-rescue, so anything past
 * 100 in a single run is almost certainly a bad cohort query.
 */
const DEFAULT_CAP = 100;

/**
 * Lightweight email shape check. NOT a full RFC 5321 validator — just
 * enough to reject obvious garbage (no @, no domain, leading whitespace).
 * Real validation happens at send time when the SMTP gateway tries delivery.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Cap resolution ─────────────────────────────────────────────────────────

function getRecipientCap(topic: string): number {
  const envKey =
    "FOUNDEROS_RECIPIENT_CAP_" +
    topic.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envVal = process.env[envKey];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CAP;
}

// ── Email normalization ────────────────────────────────────────────────────

function normalizeEmail(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!EMAIL_SHAPE.test(trimmed)) return null;
  return trimmed;
}

// ── Suppression pre-filter (batched) ───────────────────────────────────────

/**
 * Batch-load suppression rows for a list of (companyId, email, topic-or-all)
 * tuples. Returns a Set of emails that are suppressed for the given topic.
 *
 * Single round-trip; uses inArray on contact_email + the topic="all" master
 * switch is included by querying both topics in one IN clause.
 */
async function loadSuppressedEmails(
  db: Db,
  companyId: string,
  topic: SuppressionTopic,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await db
    .select({ email: customerEmailSuppressions.contactEmail })
    .from(customerEmailSuppressions)
    .where(
      and(
        eq(customerEmailSuppressions.companyId, companyId),
        inArray(customerEmailSuppressions.contactEmail, emails),
        inArray(customerEmailSuppressions.topic, [topic, "all"]),
      ),
    );
  return new Set(rows.map((r) => r.email));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * materializeRecipients — the only entry point.
 *
 * Validates, deduplicates, suppression-filters, and caps a list of
 * candidates for a workflow_run. Returns either a final recipient list or
 * a structured failure reason.
 */
export async function materializeRecipients(
  db: Db,
  args: {
    companyId: string;
    topic: SuppressionTopic;
    candidates: RecipientCandidate[];
  },
): Promise<MaterializationResult> {
  const { companyId, topic, candidates } = args;
  const cap = getRecipientCap(topic);

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: "empty_input", companyId };
  }

  const counts: DropCounts = {
    received: candidates.length,
    invalidEmail: 0,
    duplicate: 0,
    suppressed: 0,
    overCap: 0,
    retained: 0,
  };

  // Pass 1: shape validation + dedup. Track first-seen so we preserve order.
  const seen = new Map<string, MaterializedRecipient>();
  for (const c of candidates) {
    const email = normalizeEmail(c.email);
    if (!email) {
      counts.invalidEmail += 1;
      continue;
    }
    if (seen.has(email)) {
      counts.duplicate += 1;
      continue;
    }
    seen.set(email, {
      email,
      ...(c.name ? { name: c.name } : {}),
      ...(c.externalId ? { externalId: c.externalId } : {}),
      ...(c.meta ? { meta: c.meta } : {}),
    });
  }

  // Pass 2: suppression filter (batched).
  const suppressed = await loadSuppressedEmails(
    db,
    companyId,
    topic,
    Array.from(seen.keys()),
  );
  for (const email of suppressed) {
    seen.delete(email);
    counts.suppressed += 1;
  }

  // Pass 3: cap.
  const recipients = Array.from(seen.values());
  if (recipients.length > cap) {
    counts.overCap = recipients.length - cap;
    recipients.length = cap;
  }
  counts.retained = recipients.length;

  // All inputs dropped → fail-loud rather than create a no-op run.
  if (recipients.length === 0) {
    logger.warn(
      { companyId, topic, counts },
      "recipient-materialization: all candidates dropped — refusing to create empty run",
    );
    return { ok: false, reason: "all_dropped", companyId, counts };
  }

  return { ok: true, companyId, topic, recipients, counts };
}
