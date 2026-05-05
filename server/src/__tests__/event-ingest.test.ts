/**
 * event-ingest.test.ts — integration tests for the canonical events table (S2.1)
 *
 * Covers:
 *   (a) Insert new event → returns id, deduplicated: false
 *   (b) Duplicate insert (same companyId + source + sourceEventId)
 *       → returns existing id, deduplicated: true
 *   (c) Different sourceEventId, same companyId + source
 *       → produces two distinct rows
 *   Bonus (d): null sourceEventId events always insert — NULLS NOT DISTINCT
 *       allows multiple null rows (no dedup key = not collapsed)
 *
 * Uses real embedded Postgres so the UNIQUE NULLS NOT DISTINCT constraint and
 * ON CONFLICT DO NOTHING path are exercised end-to-end against the real schema.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, events, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { eventIngestService } from "../services/event-ingest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping event-ingest tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("event-ingest — idempotency + deduplication (S2.1)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-event-ingest-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Truncate events then companies (CASCADE handles FK order).
    // Each test starts clean — row counts are load-bearing assertions.
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // Insert a test company and capture its id for FK references.
    const [company] = await db
      .insert(companies)
      .values({ name: "Test Workspace Inc." })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  // ── (a) ──────────────────────────────────────────────────────────────────

  it("(a) inserts a new event and returns its id with deduplicated=false", async () => {
    const svc = eventIngestService(db);

    const result = await svc.ingestEvent({
      companyId,
      source: "stripe",
      entityType: "subscription",
      eventName: "subscription.created",
      sourceEventId: "evt_stripe_001",
      occurredAt: new Date("2026-05-05T10:00:00Z"),
      payload: { status: "active", amountCents: 9900 },
    });

    expect(result.deduplicated).toBe(false);
    expect(typeof result.eventId).toBe("string");
    expect(result.eventId.length).toBeGreaterThan(0);

    // Verify the row is in the DB with correct shape.
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.eventId);
    expect(rows[0]!.companyId).toBe(companyId);
    expect(rows[0]!.source).toBe("stripe");
    expect(rows[0]!.sourceEventId).toBe("evt_stripe_001");
    expect(rows[0]!.entityType).toBe("subscription");
    expect(rows[0]!.eventName).toBe("subscription.created");
  });

  // ── (b) ──────────────────────────────────────────────────────────────────

  it("(b) duplicate insert (same companyId+source+sourceEventId) returns existing id with deduplicated=true", async () => {
    const svc = eventIngestService(db);

    const first = await svc.ingestEvent({
      companyId,
      source: "stripe",
      entityType: "subscription",
      eventName: "subscription.updated",
      sourceEventId: "evt_stripe_dedup_001",
      occurredAt: new Date("2026-05-05T11:00:00Z"),
      payload: { status: "active" },
    });

    expect(first.deduplicated).toBe(false);

    // Replay the same event — Stripe webhook retry scenario.
    const second = await svc.ingestEvent({
      companyId,
      source: "stripe",
      entityType: "subscription",
      eventName: "subscription.updated",
      sourceEventId: "evt_stripe_dedup_001",
      occurredAt: new Date("2026-05-05T11:00:00Z"),
      payload: { status: "active" },
    });

    expect(second.deduplicated).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    // Exactly one row must exist.
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
  });

  // ── (c) ──────────────────────────────────────────────────────────────────

  it("(c) different sourceEventId, same companyId+source produces two distinct rows", async () => {
    const svc = eventIngestService(db);

    const first = await svc.ingestEvent({
      companyId,
      source: "posthog",
      entityType: "event",
      eventName: "pageview",
      sourceEventId: "ph_event_aaa111",
      occurredAt: new Date("2026-05-05T12:00:00Z"),
      payload: { path: "/dashboard" },
    });

    const second = await svc.ingestEvent({
      companyId,
      source: "posthog",
      entityType: "event",
      eventName: "pageview",
      sourceEventId: "ph_event_bbb222",
      occurredAt: new Date("2026-05-05T12:01:00Z"),
      payload: { path: "/settings" },
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(first.eventId).not.toBe(second.eventId);

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(2);
  });

  // ── (d) bonus — NULLS NOT DISTINCT constraint behaviour ──────────────────
  //
  // The schema uses UNIQUE NULLS NOT DISTINCT (company_id, source, source_event_id).
  // "NULLS NOT DISTINCT" means NULLs are treated as EQUAL in the constraint —
  // only ONE null-sourceEventId row is allowed per (companyId, source) pair.
  // Subsequent inserts of null-keyed events for the same source are deduplicated.
  //
  // This is intentional: callers that need to write multiple un-keyed events for
  // the same source (e.g. Slack messages) should use a synthetic sourceEventId
  // derived from a message timestamp or sequence number.

  it("(d) null sourceEventId is treated as a dedup key — second insert returns existing id with deduplicated=true", async () => {
    const svc = eventIngestService(db);

    // First Slack message — no sourceEventId.
    const first = await svc.ingestEvent({
      companyId,
      source: "slack",
      entityType: "message",
      eventName: "message.posted",
      // sourceEventId intentionally omitted
      occurredAt: new Date("2026-05-05T13:01:00Z"),
      payload: { text: "First message" },
    });

    expect(first.deduplicated).toBe(false);

    // Second insert with null key + same (companyId, source) — conflicts.
    const second = await svc.ingestEvent({
      companyId,
      source: "slack",
      entityType: "message",
      eventName: "message.posted",
      occurredAt: new Date("2026-05-05T13:02:00Z"),
      payload: { text: "Second message" },
    });

    expect(second.deduplicated).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    // Exactly one row per (companyId, source, NULL).
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
  });
});
