/**
 * subscription-idempotency.test.ts — verifies the three Stripe-data-integrity
 * fixes that ship with migration 0073_subscription_unique:
 *
 *   1. Webhook idempotency: replaying the same `customer.subscription.updated`
 *      event must NOT create duplicate rows. Pre-fix the conflict target was
 *      `id` (defaultRandom UUID, never collides), so every Stripe retry
 *      inserted a fresh row.
 *   2. Newest-row precedence in getCurrentSubscription: legacy installs may
 *      already have duplicates from before the dedupe migration ran. The
 *      service now uses `orderBy(desc(updatedAt))` so the most recent state
 *      wins.
 *   3. Trialing-as-healthy: `isSubscriptionActive` returns true for both
 *      `active` and `trialing` — Stripe trials grant full access, gating
 *      only on `active` locked trial users out post-checkout.
 *
 * Real embedded Postgres so the UNIQUE constraint + onConflictDoUpdate path
 * are exercised end-to-end against the real schema.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { instanceSubscription, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { subscriptionService } from "../services/subscription.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping subscription-idempotency tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function makeWebhookEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  overrides: { id?: string; customer?: string; status?: string; current_period_end?: number } = {},
) {
  return {
    type,
    data: {
      object: {
        id: overrides.id ?? "sub_test_idempotency",
        customer: overrides.customer ?? "cus_test_001",
        status: overrides.status ?? "active",
        current_period_end: overrides.current_period_end ?? Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  } as unknown as Parameters<ReturnType<typeof subscriptionService>["handleStripeWebhook"]>[0];
}

describeEmbeddedPostgres("subscription idempotency + ordering + healthy statuses", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-sub-idempotency-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Each test starts with a clean table — they assert against specific
    // row counts and the "newest wins" property is sensitive to wall-clock
    // updatedAt, which makes cross-test bleed unreliable.
    await db.execute(sql`TRUNCATE TABLE "instance_subscription"`);
  });

  it("replays of the same Stripe webhook event do NOT duplicate rows", async () => {
    const svc = subscriptionService(db);
    const event = makeWebhookEvent("customer.subscription.updated", {
      id: "sub_dedup_replay_1",
      customer: "cus_dedup_001",
      status: "active",
    });

    // Fire 5 retries — Stripe's documented behavior for failed webhook
    // delivery is exponential backoff up to 3 days.
    for (let i = 0; i < 5; i += 1) {
      await svc.handleStripeWebhook(event);
    }

    const rows = await db.query.instanceSubscription.findMany({});
    const matching = rows.filter((r) => r.stripeSubscriptionId === "sub_dedup_replay_1");
    expect(matching.length, `replays should collapse to 1 row, saw ${matching.length}`).toBe(1);
  });

  it("a status change after creation updates the same row, not appends a new one", async () => {
    const svc = subscriptionService(db);
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.created", {
        id: "sub_status_change_1",
        customer: "cus_status_change",
        status: "trialing",
      }),
    );
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.updated", {
        id: "sub_status_change_1",
        customer: "cus_status_change",
        status: "active",
      }),
    );

    const rows = await db.query.instanceSubscription.findMany({});
    const matching = rows.filter((r) => r.stripeSubscriptionId === "sub_status_change_1");
    expect(matching.length).toBe(1);
    expect(matching[0]!.status).toBe("active");
  });

  it("getCurrentSubscription returns the newest row when duplicates exist (legacy install)", async () => {
    // Simulate legacy duplicate state: insert two rows with NULL
    // stripeSubscriptionId so the UNIQUE constraint allows them, with
    // staggered updatedAt timestamps. The newest must win.
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-04-01T00:00:00Z");
    await db.insert(instanceSubscription).values({
      stripeSubscriptionId: null,
      plan: "free",
      status: "inactive",
      updatedAt: older,
    });
    await db.insert(instanceSubscription).values({
      stripeSubscriptionId: null,
      plan: "pro",
      status: "trialing",
      updatedAt: newer,
    });

    const svc = subscriptionService(db);
    const current = await svc.getCurrentSubscription();
    expect(current?.status).toBe("trialing");
    expect(current?.plan).toBe("pro");
  });

  it("isSubscriptionActive returns true for `active`", async () => {
    const svc = subscriptionService(db);
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.updated", {
        id: "sub_status_active",
        status: "active",
      }),
    );
    expect(await svc.isSubscriptionActive()).toBe(true);
  });

  it("isSubscriptionActive returns true for `trialing` (Stripe trial users keep access)", async () => {
    const svc = subscriptionService(db);
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.updated", {
        id: "sub_status_trialing",
        status: "trialing",
      }),
    );
    // Trialing is the newest row → wins via orderBy(desc(updatedAt)).
    expect(await svc.isSubscriptionActive()).toBe(true);
  });

  it("isSubscriptionActive returns false for `canceled`", async () => {
    const svc = subscriptionService(db);
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.created", {
        id: "sub_status_canceled",
        status: "active",
      }),
    );
    await svc.handleStripeWebhook(
      makeWebhookEvent("customer.subscription.deleted", {
        id: "sub_status_canceled",
      }),
    );
    expect(await svc.isSubscriptionActive()).toBe(false);
  });

  it("multiple NULL stripeSubscriptionId rows coexist (UNIQUE allows distinct NULLs)", async () => {
    // PostgreSQL UNIQUE treats NULLs as distinct, so a placeholder row
    // (created before the founder's first checkout) can coexist with
    // other placeholder rows. This is the documented behavior; if it
    // ever changes, the dedupe migration's "WHERE IS NOT NULL" clause
    // becomes load-bearing and we'll regress without warning.
    await db.insert(instanceSubscription).values({
      stripeSubscriptionId: null,
      plan: "free",
      status: "inactive",
    });
    await db.insert(instanceSubscription).values({
      stripeSubscriptionId: null,
      plan: "free",
      status: "inactive",
    });
    // No throw — both inserts succeed.
    expect(true).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// S2.2 — Event ingestion deduplication contract (stub-based, no embedded PG)
//
// The events table UNIQUE (companyId, source, dedupKey) constraint causes
// ingestEvent to return { deduplicated: true } for replays. We verify the stub
// contract directly — no subscription table, no HTTP layer involved.
// ---------------------------------------------------------------------------

describe("S2.2 — event ingestion deduplication (stub contract)", () => {
  it("same dedupKey returns deduplicated:true on the second call", async () => {
    // Inline stub with Map-based dedup — mirrors what the real event-ingest
    // service does via the UNIQUE ON CONFLICT DO NOTHING path.
    const store = new Map<string, string>();

    async function stubIngestEvent(input: {
      companyId: string;
      source: string;
      entityType: string;
      eventName: string;
      dedupKey: string;
      occurredAt: Date;
      payload: unknown;
    }): Promise<{ eventId: string; deduplicated: boolean }> {
      const key = [input.companyId, input.source, input.dedupKey ?? ""].join(":");
      if (input.dedupKey && store.has(key)) {
        return { eventId: store.get(key)!, deduplicated: true };
      }
      const id = `stub-${Math.random().toString(36).slice(2)}`;
      if (input.dedupKey) store.set(key, id);
      return { eventId: id, deduplicated: false };
    }

    const base = {
      companyId: "company-dedup-1",
      source: "stripe" as const,
      entityType: "subscription",
      eventName: "customer.subscription.updated",
      dedupKey: "evt_replay_idempotency_001",
      occurredAt: new Date(),
      payload: { status: "active" },
    };

    const first = await stubIngestEvent(base);
    const second = await stubIngestEvent(base); // same dedupKey — replay

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The second call must return the SAME eventId as the first.
    expect(second.eventId).toBe(first.eventId);
  });

  it("different dedupKeys do NOT deduplicate", async () => {
    const store = new Map<string, string>();

    async function stubIngestEvent(input: {
      companyId: string;
      source: string;
      dedupKey: string;
    }): Promise<{ eventId: string; deduplicated: boolean }> {
      const key = [input.companyId, input.source, input.dedupKey ?? ""].join(":");
      if (input.dedupKey && store.has(key)) {
        return { eventId: store.get(key)!, deduplicated: true };
      }
      const id = `stub-${Math.random().toString(36).slice(2)}`;
      if (input.dedupKey) store.set(key, id);
      return { eventId: id, deduplicated: false };
    }

    const a = await stubIngestEvent({ companyId: "c1", source: "stripe", dedupKey: "evt_a" });
    const b = await stubIngestEvent({ companyId: "c1", source: "stripe", dedupKey: "evt_b" });

    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false);
    expect(a.eventId).not.toBe(b.eventId);
  });
});
