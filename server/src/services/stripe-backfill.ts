/**
 * stripe-backfill.ts — Historical Stripe data ingestion service (S2.2)
 *
 * `backfillCompanyStripe` paginates Stripe's REST API for subscriptions,
 * customers, and invoices, and pushes each item into the canonical events
 * table via ingestEvent. The events table's UNIQUE constraint on
 * (companyId, source, sourceEventId) makes every call idempotent — running
 * the backfill twice produces the same row count as running it once.
 *
 * Pagination strategy:
 *   Stripe list endpoints return at most 100 objects per page. We iterate
 *   using the `has_more` + `starting_after` cursor pattern until exhausted.
 *
 * Filtering:
 *   `sinceDays` (default 90) gates on `created >= now - sinceDays * 86400`.
 *   Stripe's `created[gte]` filter is applied server-side.
 *
 * Error handling:
 *   Per-item errors are collected and returned in `errors[]` — a single bad
 *   object does not abort the entire backfill. The caller (HTTP endpoint)
 *   reports the partial result.
 *
 * TODO(S2.1): replace stub import with real ingestEvent import once events table merges
 */

import Stripe from "stripe";
import { logger } from "../middleware/logger.js";
// TODO(S2.1): replace with real ingestEvent import once events table merges
import { ingestEvent } from "./event-ingest-stub.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** How many days of history to backfill. Defaults to 90. */
  sinceDays?: number;
}

export interface BackfillResult {
  ingested: number;
  deduplicated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 100;

function sinceTimestamp(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86_400;
}

// ---------------------------------------------------------------------------
// Core backfill
// ---------------------------------------------------------------------------

/**
 * Backfill historical Stripe data for a company into the canonical events table.
 *
 * @param companyId  FounderOS company UUID.
 * @param stripeKey  Stripe secret key for this company's account.
 * @param options    Optional backfill configuration.
 */
export async function backfillCompanyStripe(
  companyId: string,
  stripeKey: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const sinceDays = options.sinceDays ?? 90;
  const createdGte = sinceTimestamp(sinceDays);

  const stripe = new Stripe(stripeKey, {
    apiVersion: "2026-03-25.dahlia" as const,
    typescript: true,
    appInfo: { name: "FounderOS/backfill", version: "0.3.1" },
  });

  const result: BackfillResult = { ingested: 0, deduplicated: 0, errors: [] };

  // Run customers, subscriptions, and invoices in sequence to avoid
  // saturating Stripe's rate limit (100 req/s per key).
  await backfillCustomers(stripe, companyId, createdGte, result);
  await backfillSubscriptions(stripe, companyId, createdGte, result);
  await backfillInvoices(stripe, companyId, createdGte, result);

  logger.info(
    {
      companyId,
      sinceDays,
      ingested: result.ingested,
      deduplicated: result.deduplicated,
      errors: result.errors.length,
    },
    "stripe-backfill: complete",
  );

  return result;
}

// ---------------------------------------------------------------------------
// Per-resource paginators
// ---------------------------------------------------------------------------

async function backfillCustomers(
  stripe: Stripe,
  companyId: string,
  createdGte: number,
  result: BackfillResult,
): Promise<void> {
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.customers.list({
      limit: PAGE_LIMIT,
      created: { gte: createdGte },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const customer of page.data) {
      await ingestItem(
        {
          companyId,
          source: "stripe",
          entityType: "customer",
          eventName: "customer.created",
          sourceEventId: `backfill:customer:${customer.id}`,
          occurredAt: new Date(customer.created * 1000),
          payload: customer,
        },
        result,
      );
    }

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

async function backfillSubscriptions(
  stripe: Stripe,
  companyId: string,
  createdGte: number,
  result: BackfillResult,
): Promise<void> {
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.subscriptions.list({
      limit: PAGE_LIMIT,
      created: { gte: createdGte },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const sub of page.data) {
      await ingestItem(
        {
          companyId,
          source: "stripe",
          entityType: "subscription",
          eventName: "customer.subscription.created",
          sourceEventId: `backfill:subscription:${sub.id}`,
          occurredAt: new Date(sub.created * 1000),
          payload: sub,
        },
        result,
      );
    }

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

async function backfillInvoices(
  stripe: Stripe,
  companyId: string,
  createdGte: number,
  result: BackfillResult,
): Promise<void> {
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.invoices.list({
      limit: PAGE_LIMIT,
      created: { gte: createdGte },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const invoice of page.data) {
      await ingestItem(
        {
          companyId,
          source: "stripe",
          entityType: "invoice",
          eventName: "invoice.created",
          sourceEventId: `backfill:invoice:${invoice.id}`,
          occurredAt: new Date(invoice.created * 1000),
          payload: invoice,
        },
        result,
      );
    }

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

// ---------------------------------------------------------------------------
// Shared per-item ingest helper
// ---------------------------------------------------------------------------

async function ingestItem(
  input: Parameters<typeof ingestEvent>[0],
  result: BackfillResult,
): Promise<void> {
  try {
    const r = await ingestEvent(input);
    if (r.deduplicated) {
      result.deduplicated += 1;
    } else {
      result.ingested += 1;
    }
  } catch (err) {
    const msg =
      err instanceof Error
        ? `${input.sourceEventId}: ${err.message}`
        : `${input.sourceEventId}: unknown error`;
    result.errors.push(msg);
    logger.warn(
      { err, sourceEventId: input.sourceEventId, companyId: input.companyId },
      "stripe-backfill: item ingest failed (continuing)",
    );
  }
}
