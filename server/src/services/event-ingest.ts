/**
 * event-ingest.ts — Canonical event ingestion service (S2.1)
 *
 * Single write path for all integration sources (Stripe, PostHog, LinkedIn,
 * Notion, Slack, HubSpot) to persist normalized event rows.
 *
 * Deduplication strategy:
 *   UNIQUE (company_id, source, source_event_id) NULLS NOT DISTINCT
 *   - If source_event_id is provided: INSERT … ON CONFLICT DO NOTHING … RETURNING
 *     detects replays — no row returned means the event already exists, so we
 *     SELECT the existing row and return it with deduplicated: true.
 *   - If source_event_id is null: the NULLS NOT DISTINCT constraint allows
 *     multiple NULL rows (events with no dedup key are always inserted).
 *
 * BullMQ derive queue (events.derive):
 *   Stubbed for v1. Set EVENTS_DERIVE_QUEUE_ENABLED=true to enable.
 *   When enabled the service will attempt to enqueue a derive job after each
 *   non-deduplicated insert for downstream KPI calculation (S2.9).
 *   Failures to enqueue are logged but do NOT cause ingestEvent to throw —
 *   the row is the durable record; the queue is best-effort.
 *
 *   TODO(S2.8/S2.9): wire in BullMQ queue when queue infra lands.
 *   Expected import: `import { getQueue, QUEUE_NAMES } from "../lib/queues.js"`
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { events, type EventSource } from "@founderos/db";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Feature flag — BullMQ derive queue (off by default in v1)
// ---------------------------------------------------------------------------

function isEventsDeriveQueueEnabled(): boolean {
  return process.env.EVENTS_DERIVE_QUEUE_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestEventInput {
  companyId: string;
  source: EventSource;
  entityType: string;
  eventName: string;
  sourceEventId?: string;
  occurredAt: Date;
  payload: unknown;
}

export interface IngestEventResult {
  eventId: string;
  deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Returns an `ingestEvent` function bound to the provided Drizzle `db`
 * instance. Callers (routes, tests) inject db so the service is testable
 * without global state.
 */
export function eventIngestService(db: Db) {
  /**
   * Idempotently ingest a normalized event row.
   *
   * @returns { eventId, deduplicated }
   *   - `deduplicated: true`  — (companyId, source, sourceEventId) already existed;
   *                             returns the original row's id.
   *   - `deduplicated: false` — first write; returns the new row's id.
   */
  async function ingestEvent(input: IngestEventInput): Promise<IngestEventResult> {
    const {
      companyId,
      source,
      entityType,
      eventName,
      sourceEventId,
      occurredAt,
      payload,
    } = input;

    // Attempt insert; the dedup UNIQUE constraint causes a no-op on conflict.
    const inserted = await db
      .insert(events)
      .values({
        companyId,
        source,
        entityType,
        eventName,
        sourceEventId: sourceEventId ?? null,
        occurredAt,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: events.id });

    if (inserted.length > 0) {
      const eventId = inserted[0].id;

      // Non-deduplicated insert — enqueue derive job if enabled.
      if (isEventsDeriveQueueEnabled()) {
        // TODO(S2.8/S2.9): replace stub with real BullMQ enqueue once
        // `server/src/lib/queues.ts` lands (feat/s2-dlq-retries).
        // const queue = getQueue(QUEUE_NAMES.EVENTS_DERIVE);
        // await queue.add("derive", { eventId, companyId, source, eventName });
        logger.info(
          { eventId, companyId, source, eventName },
          "event-ingest: derive queue enqueue stubbed (EVENTS_DERIVE_QUEUE_ENABLED=true but queue infra not yet wired)",
        );
      }

      return { eventId, deduplicated: false };
    }

    // INSERT returned no rows → UNIQUE conflict occurred.
    // The constraint is UNIQUE NULLS NOT DISTINCT (company_id, source, source_event_id),
    // so NULLs are treated as equal — only one null-sourceEventId row is allowed per
    // (companyId, source) tuple. Build the WHERE clause accordingly.
    const sourceIdIsNull = sourceEventId == null;
    const existing = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.source, source),
          sourceIdIsNull
            ? isNull(events.sourceEventId)
            : eq(events.sourceEventId, sourceEventId!),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      // Should be unreachable: if INSERT conflicted the row must exist.
      throw new Error(
        `event-ingest: dedup conflict but existing row not found ` +
          `(companyId=${companyId} source=${source} sourceEventId=${String(sourceEventId)})`,
      );
    }

    return { eventId: existing[0].id, deduplicated: true };
  }

  return { ingestEvent };
}

// ---------------------------------------------------------------------------
// App-level singleton — lazy init, call initEventIngest(db) at server startup
// ---------------------------------------------------------------------------

let _service: ReturnType<typeof eventIngestService> | null = null;

/**
 * Bind the app-level singleton to the shared db instance.
 * Must be called once during server startup before any requests arrive.
 */
export function initEventIngest(db: Db): void {
  _service = eventIngestService(db);
}

/**
 * Ingest via the app-level singleton.
 * Throws if initEventIngest was never called.
 */
export async function ingestEvent(input: IngestEventInput): Promise<IngestEventResult> {
  if (!_service) {
    throw new Error(
      "event-ingest: initEventIngest() must be called before ingestEvent(). " +
        "Call it in server/src/index.ts after createDb().",
    );
  }
  return _service.ingestEvent(input);
}
