/**
 * Re-export of event-ingest service for convenience.
 * The canonical implementation lives at server/src/services/event-ingest.ts
 */

export { ingestEvent, type IngestEventInput, type IngestEventResult } from "../event-ingest.js";
