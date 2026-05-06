/**
 * customer-email-suppressions — S4.8 prerequisite #196 layer 3a.
 *
 * Read + write helpers for the customer_email_suppressions table.
 * Pre-send check + idempotent suppression insert; called from:
 *   - workflow templates (pre-send check before email transport invocation)
 *   - unsubscribe route handler (insert on click — layer 3b)
 *   - Resend webhook receiver (insert on hard bounce / spam report — layer 4)
 *
 * Council 2026-05-06 finding #4 (BLOCK): customer-facing templates had NO
 * suppression model. Layer 1 shipped the schema; layer 2 the HMAC token
 * service; this layer ships the data-access surface.
 *
 * Topic 'all' is the master switch — `isSuppressed(db, c, e, "onboarding")`
 * returns true whether the row stored topic="onboarding" OR topic="all". This
 * lets users opt out of everything with one row without cascading deletes
 * across topic-specific rows.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  customerEmailSuppressions,
  type CustomerEmailSuppressionInsert,
  type SuppressionTopic,
} from "@founderos/db";

/**
 * Pre-send check: returns true if (companyId, contactEmail, topic) OR
 * (companyId, contactEmail, 'all') has a suppression row. Email is
 * normalized to lowercase before lookup so callers don't need to pre-normalize.
 *
 * Uses the (company_id, contact_email) index — the topic filter is applied
 * during the index scan. Always-fast lookup on what is expected to be a
 * cardinality-small table per tenant.
 */
export async function isSuppressed(
  db: Db,
  companyId: string,
  contactEmail: string,
  topic: SuppressionTopic,
): Promise<boolean> {
  const normalized = contactEmail.toLowerCase().trim();
  const rows = await db
    .select({ id: customerEmailSuppressions.id })
    .from(customerEmailSuppressions)
    .where(
      and(
        eq(customerEmailSuppressions.companyId, companyId),
        eq(customerEmailSuppressions.contactEmail, normalized),
        inArray(customerEmailSuppressions.topic, [topic, "all"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Idempotent insert via ON CONFLICT (company_id, contact_email, topic) DO NOTHING.
 *
 * Returns { inserted: true } on new row, { inserted: false } when a row already
 * exists (re-click of same unsubscribe link, repeated bounce on same address,
 * concurrent insert race resolved by unique constraint).
 *
 * Caller MUST pre-normalize contactEmail to lowercase. The DB CHECK constraint
 * (contact_email = lower(contact_email)) rejects uppercase as defense-in-depth,
 * but app-layer normalization keeps the contract clean and avoids round-tripped
 * 23514 errors.
 */
export async function insertSuppression(
  db: Db,
  input: CustomerEmailSuppressionInsert,
): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(customerEmailSuppressions)
    .values(input)
    .onConflictDoNothing({
      target: [
        customerEmailSuppressions.companyId,
        customerEmailSuppressions.contactEmail,
        customerEmailSuppressions.topic,
      ],
    })
    .returning({ id: customerEmailSuppressions.id });
  return { inserted: result.length > 0 };
}

/**
 * Convenience wrapper: normalize email then insert. Most callers should use
 * this instead of `insertSuppression` directly to avoid the lowercase-trap.
 */
export async function recordSuppression(
  db: Db,
  args: {
    companyId: string;
    contactEmail: string;
    topic: SuppressionTopic;
    reason: CustomerEmailSuppressionInsert["reason"];
    sourceWorkflowRunId?: string;
    sourceMessageId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ inserted: boolean }> {
  return insertSuppression(db, {
    companyId: args.companyId,
    contactEmail: args.contactEmail.toLowerCase().trim(),
    topic: args.topic,
    reason: args.reason,
    sourceWorkflowRunId: args.sourceWorkflowRunId,
    sourceMessageId: args.sourceMessageId,
    metadata: args.metadata ?? {},
  });
}
