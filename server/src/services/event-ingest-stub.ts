/**
 * event-ingest-stub.ts — Contract stub for S2.1 (events table + ingestion).
 *
 * S2.1 is being built in parallel on feat/s2-events-table. This stub satisfies
 * the same exported interface so S2.3 (PostHog connector) can type-check and
 * test independently. The orchestrator swaps this import for the real impl
 * on rebase.
 *
 * Shape mirrors the S2.1 spec:
 *   ingestEvent(input) → Promise<{ eventId, deduplicated }>
 */

export type EventSource =
  | "posthog"
  | "stripe"
  | "linkedin"
  | "notion"
  | "slack"
  | "hubspot";

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

/**
 * Stub: returns a synthetic id. Real impl writes to `events` table.
 * For tests, callers should inject a mock or spy on this export.
 */
export async function ingestEvent(
  input: IngestEventInput,
): Promise<IngestEventResult> {
  return {
    eventId: `stub-${input.source}-${Date.now()}`,
    deduplicated: false,
  };
}

export function eventIngestService(_db: unknown) {
  return { ingestEvent };
}
