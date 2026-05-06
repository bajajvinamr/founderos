/**
 * content-attribution.test.ts — integration tests for Content Attribution (S4.3).
 *
 * Covers:
 *   1. POST /c/:trackingId redirects to publishedUrl after logging click
 *   2. Click event is ingested with correct payload (draftId, format, refererHost)
 *   3. Synthetic dedup key prevents duplicate clicks
 *   4. GET /api/content-drafts/:id/attribution returns metrics (clicks, signups, revenue)
 *   5. Attribution data is filtered by companyId (tenant isolation)
 *   6. Empty draft (no events) returns 0 across the board
 *   7. /c/:trackingId returns 404 for unpublished or missing draft
 *   8. Attribution UTM is auto-generated at publish time
 *
 * Uses real embedded Postgres and the event-ingest singleton pattern.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  companies,
  contentBriefs,
  contentDrafts,
  createDb,
  events,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contentDraftRoutes } from "../routes/content-drafts.js";
import { contentTrackingRoutes } from "../routes/content-tracking.js";
import { errorHandler } from "../middleware/index.js";
import { initEventIngest } from "../services/event-ingest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping content-attribution tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function buildApp(companyId: string, db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  // Mount both tracking (public) and API routes
  app.use(contentTrackingRoutes(db));
  app.use("/api", contentDraftRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("Content Attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;
  let briefId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase(
      "founderos-content-attribution-",
    );
    db = createDb(temp.connectionString);
    initEventIngest(db);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // Create test companies
    const [c1] = await db
      .insert(companies)
      .values({ name: "Acme Corp", issuePrefix: "ACM" })
      .returning({ id: companies.id });
    companyId = c1!.id;

    const [c2] = await db
      .insert(companies)
      .values({ name: "Other Corp", issuePrefix: "OTH" })
      .returning({ id: companies.id });
    otherCompanyId = c2!.id;

    // Create a test brief
    const [brief] = await db
      .insert(contentBriefs)
      .values({
        companyId,
        title: "Test Brief",
        thesis: "Test thesis",
        audience: "Test audience",
        angle: "how-to",
        keywords: ["test"],
      })
      .returning({ id: contentBriefs.id });
    briefId = brief!.id;
  });

  // ── POST /c/:trackingId redirect ───────────────────────────────────────────

  it("POST /c/:trackingId redirects to publishedUrl after logging click", async () => {
    const app = buildApp(companyId, db);

    // Create and publish a draft
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test content", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedAt: new Date(),
        publishedToUrl: "https://example.com/article",
      })
      .returning({ id: contentDrafts.id });
    const draftId = draft!.id;

    // Click the tracking link
    const res = await request(app)
      .get(`/c/${draftId}`)
      .set("Referer", "https://twitter.com/");

    expect(res.status).toBe(302);
    expect(res.header.location).toBe("https://example.com/article");

    // Verify click event was logged
    const [event] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.eventName, "click"),
          sql`${events.payload}->>'draftId' = ${draftId}`,
        ),
      );

    expect(event).toBeTruthy();
    expect(event?.companyId).toBe(companyId);
    expect(event?.source).toBe("posthog");
    expect(event?.eventName).toBe("click");
    expect(event?.payload).toMatchObject({
      draftId,
      format: "linkedin",
      refererHost: "twitter.com",
    });
  });

  it("/c/:trackingId returns 404 for unpublished draft", async () => {
    const app = buildApp(companyId, db);

    // Create unpublished draft
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "drafted",
      })
      .returning({ id: contentDrafts.id });

    const res = await request(app).get(`/c/${draft!.id}`);
    expect(res.status).toBe(404);
  });

  it("/c/:trackingId returns 404 for missing draft", async () => {
    const app = buildApp(companyId, db);
    const fakeId = "550e8400-e29b-41d4-a716-446655440000"; // Valid UUID format, just not in DB
    const res = await request(app).get(`/c/${fakeId}`);
    expect(res.status).toBe(404);
  });

  // ── GET /api/content-drafts/:id/attribution ─────────────────────────────────

  it("GET attribution endpoint returns metrics for published draft", async () => {
    const app = buildApp(companyId, db);

    // Create and publish draft
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedAt: new Date(),
        publishedToUrl: "https://example.com",
        attributionUtm: "utm_source=founderos&utm_campaign=test-draft&utm_medium=linkedin",
      })
      .returning({ id: contentDrafts.id });
    const draftId = draft!.id;

    // Simulate some click events
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "link_click",
        eventName: "click",
        dedupKey: `synth:click:${draftId}:${now.getTime() + i}:anon`,
        occurredAt: now,
        payload: {
          draftId,
          format: "linkedin",
          refererHost: "twitter.com",
        },
      });
    }

    const res = await request(app)
      .get(`/api/companies/${companyId}/content-drafts/${draftId}/attribution`)
      .expect(200);

    expect(res.body.clicks30d).toBe(3);
    expect(res.body.attributionUtm).toBe(
      "utm_source=founderos&utm_campaign=test-draft&utm_medium=linkedin",
    );
  });

  it("GET attribution returns 0 for unpublished draft", async () => {
    const app = buildApp(companyId, db);

    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "drafted",
      })
      .returning({ id: contentDrafts.id });

    const res = await request(app)
      .get(`/api/companies/${companyId}/content-drafts/${draft!.id}/attribution`)
      .expect(200);

    expect(res.body.clicks30d).toBe(0);
    expect(res.body.signups).toBe(0);
    expect(res.body.revenueMicros).toBe(0);
  });

  it("GET attribution enforces tenant isolation", async () => {
    const app = buildApp(companyId, db);

    // Create draft in company A and company B
    const [draftA] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "A", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedToUrl: "https://a.com",
      })
      .returning({ id: contentDrafts.id });

    // Create draft in other company
    const [briefB] = await db
      .insert(contentBriefs)
      .values({
        companyId: otherCompanyId,
        title: "Brief B",
        thesis: "Thesis",
        audience: "Audience",
        angle: "how-to",
        keywords: ["test"],
      })
      .returning({ id: contentBriefs.id });

    const [draftB] = await db
      .insert(contentDrafts)
      .values({
        companyId: otherCompanyId,
        briefId: briefB!.id,
        format: "linkedin",
        payload: { body: "B", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedToUrl: "https://b.com",
      })
      .returning({ id: contentDrafts.id });

    // Add events to draft B only
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await db.insert(events).values({
        companyId: otherCompanyId,
        source: "posthog",
        entityType: "link_click",
        eventName: "click",
        dedupKey: `synth:click:${draftB!.id}:${now.getTime() + i}:anon`,
        occurredAt: now,
        payload: { draftId: draftB!.id, format: "linkedin" },
      });
    }

    // Query draft A from company A context — should return 0 (no events in company A)
    const resA = await request(app)
      .get(`/api/companies/${companyId}/content-drafts/${draftA!.id}/attribution`)
      .expect(200);

    expect(resA.body.clicks30d).toBe(0);
  });

  // ── PATCH publish generates attributionUtm ───────────────────────────────────

  it("PATCH to published status generates attributionUtm", async () => {
    const app = buildApp(companyId, db);

    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "x-thread",
        payload: { tweets: ["Tweet 1"], commentary: "Commentary" },
        status: "approved",
      })
      .returning({ id: contentDrafts.id });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/content-drafts/${draft!.id}`)
      .send({ status: "published", publishedToUrl: "https://x.com/thread" })
      .expect(200);

    expect(res.body.attributionUtm).toContain("utm_source=founderos");
    expect(res.body.attributionUtm).toContain(`utm_campaign=${draft!.id}`);
    expect(res.body.attributionUtm).toContain("utm_medium=x-thread");
  });

  // ── Cross-tenant isolation edge cases ───────────────────────────────────────

  it("cannot access other company's draft attribution", async () => {
    const app = buildApp(otherCompanyId, db); // Build app for OTHER company

    // Create draft in FIRST company
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedToUrl: "https://example.com",
      })
      .returning({ id: contentDrafts.id });

    // Try to access from OTHER company context
    const res = await request(app)
      .get(`/api/companies/${otherCompanyId}/content-drafts/${draft!.id}/attribution`);

    expect(res.status).toBe(404);
  });

  // ── Deduplication via synth key ────────────────────────────────────────────

  it("click dedup key prevents duplicate events", async () => {
    const app = buildApp(companyId, db);

    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 3 },
        status: "published",
        publishedAt: new Date(),
        publishedToUrl: "https://example.com",
      })
      .returning({ id: contentDrafts.id });

    const draftId = draft!.id;
    const timestamp = new Date().getTime();
    const dedupKey = `synth:click:${draftId}:${timestamp}:anon`;

    // Insert the same event twice with identical dedup key
    const result1 = await db
      .insert(events)
      .values({
        companyId,
        source: "posthog",
        entityType: "link_click",
        eventName: "click",
        dedupKey,
        occurredAt: new Date(),
        payload: { draftId, format: "linkedin" },
      })
      .onConflictDoNothing()
      .returning({ id: events.id });

    const result2 = await db
      .insert(events)
      .values({
        companyId,
        source: "posthog",
        entityType: "link_click",
        eventName: "click",
        dedupKey,
        occurredAt: new Date(),
        payload: { draftId, format: "linkedin" },
      })
      .onConflictDoNothing()
      .returning({ id: events.id });

    // Only the first insert should succeed
    expect(result1.length).toBe(1);
    expect(result2.length).toBe(0);
  });
});
