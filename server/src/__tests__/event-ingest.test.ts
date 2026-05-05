/**
 * event-ingest.test.ts — integration tests for the canonical events table (S2.1)
 *
 * Covers:
 *   (a) Insert new event → returns id, deduplicated: false
 *   (b) Duplicate insert (same companyId + source + dedupKey) → existing id,
 *       deduplicated: true (Stripe webhook replay scenario)
 *   (c) Different dedupKey, same (companyId, source) → two distinct rows
 *   (d) Synthesized dedupKey for sources without a natural ID (Slack pattern)
 *       — distinct synthetic keys produce distinct rows, demonstrating the
 *       canonical "synthesize when no natural ID" caller pattern
 *   (e) Empty/whitespace dedupKey is rejected at runtime — the service refuses
 *       null/empty keys to prevent the silent-loss footgun the council BLOCK
 *       called out
 *
 * Uses real embedded Postgres so the UNIQUE constraint, NOT NULL on dedup_key,
 * and ON CONFLICT DO NOTHING path are exercised end-to-end against the schema.
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
      dedupKey: "evt_stripe_001",
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
    expect(rows[0]!.dedupKey).toBe("evt_stripe_001");
    expect(rows[0]!.entityType).toBe("subscription");
    expect(rows[0]!.eventName).toBe("subscription.created");
  });

  // ── (b) ──────────────────────────────────────────────────────────────────

  it("(b) duplicate insert (same companyId+source+dedupKey) returns existing id with deduplicated=true", async () => {
    const svc = eventIngestService(db);

    const first = await svc.ingestEvent({
      companyId,
      source: "stripe",
      entityType: "subscription",
      eventName: "subscription.updated",
      dedupKey: "evt_stripe_dedup_001",
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
      dedupKey: "evt_stripe_dedup_001",
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

  it("(c) different dedupKey, same companyId+source produces two distinct rows", async () => {
    const svc = eventIngestService(db);

    const first = await svc.ingestEvent({
      companyId,
      source: "posthog",
      entityType: "event",
      eventName: "pageview",
      dedupKey: "ph_event_aaa111",
      occurredAt: new Date("2026-05-05T12:00:00Z"),
      payload: { path: "/dashboard" },
    });

    const second = await svc.ingestEvent({
      companyId,
      source: "posthog",
      entityType: "event",
      eventName: "pageview",
      dedupKey: "ph_event_bbb222",
      occurredAt: new Date("2026-05-05T12:01:00Z"),
      payload: { path: "/settings" },
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(first.eventId).not.toBe(second.eventId);

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(2);
  });

  // ── (d) Synthesized dedup key for sources without a natural ID ──────────
  //
  // Sources like Slack don't expose a per-message id in the shape we want.
  // The canonical pattern is to synthesize a dedup key from message metadata
  // (channel + ts + user). Distinct synthetic keys → distinct rows; identical
  // synthetic key (replay of the same message) deduplicates.

  it("(d) synthesized Slack dedupKey produces distinct rows for distinct messages and dedups on replay", async () => {
    const svc = eventIngestService(db);

    const slackKey = (channel: string, ts: string, user: string) =>
      `${channel}:${ts}:${user}`;

    const first = await svc.ingestEvent({
      companyId,
      source: "slack",
      entityType: "message",
      eventName: "message.posted",
      dedupKey: slackKey("C123", "1779200000.000100", "U001"),
      occurredAt: new Date("2026-05-05T13:01:00Z"),
      payload: { text: "First message" },
    });

    const second = await svc.ingestEvent({
      companyId,
      source: "slack",
      entityType: "message",
      eventName: "message.posted",
      dedupKey: slackKey("C123", "1779200000.000200", "U002"),
      occurredAt: new Date("2026-05-05T13:02:00Z"),
      payload: { text: "Second message" },
    });

    // Replay first message — Slack RTM reconnect duplicate.
    const replay = await svc.ingestEvent({
      companyId,
      source: "slack",
      entityType: "message",
      eventName: "message.posted",
      dedupKey: slackKey("C123", "1779200000.000100", "U001"),
      occurredAt: new Date("2026-05-05T13:01:00Z"),
      payload: { text: "First message" },
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(first.eventId).not.toBe(second.eventId);
    expect(replay.deduplicated).toBe(true);
    expect(replay.eventId).toBe(first.eventId);

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(2);
  });

  // ── (e) Empty/whitespace dedupKey is rejected ───────────────────────────
  //
  // The council BLOCK fix replaced UNIQUE NULLS NOT DISTINCT with NOT NULL +
  // a runtime guard. The DB CHECK + NOT NULL would reject empty inserts at
  // the SQL layer too, but throwing in the service gives a clearer error
  // message that names the source and points the developer at the synthetic-
  // key pattern.

  it("(e) empty or whitespace dedupKey throws a descriptive error", async () => {
    const svc = eventIngestService(db);

    await expect(
      svc.ingestEvent({
        companyId,
        source: "slack",
        entityType: "message",
        eventName: "message.posted",
        dedupKey: "",
        occurredAt: new Date("2026-05-05T14:00:00Z"),
        payload: { text: "no key" },
      }),
    ).rejects.toThrow(/dedupKey is required/);

    await expect(
      svc.ingestEvent({
        companyId,
        source: "slack",
        entityType: "message",
        eventName: "message.posted",
        dedupKey: "   ",
        occurredAt: new Date("2026-05-05T14:01:00Z"),
        payload: { text: "whitespace key" },
      }),
    ).rejects.toThrow(/dedupKey is required/);

    // No rows were inserted for the rejected attempts.
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(0);
  });
});
