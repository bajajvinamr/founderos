/**
 * content-briefs.test.ts — integration tests for the Content Briefs API (S4.1).
 *
 * Covers:
 *   1.  POST creates a brief with status='draft' by default
 *   2.  GET list returns newest-first, paginated
 *   3.  GET list ?status= filters correctly
 *   4.  GET single by id returns 200
 *   5.  GET single with wrong company returns 404 (tenant isolation)
 *   6.  PATCH updates mutable fields; updatedAt advances
 *   7.  PATCH with unknown id returns 404
 *   8.  POST /transition enforces the state machine (valid path)
 *   9.  POST /transition rejects invalid hop (e.g. draft → published)
 *   10. POST /transition on wrong company returns 404
 *   11. DB CHECK constraint rejects unknown status via raw SQL
 *   12. Zod rejects title='' at the route layer (400)
 *   13. Zod rejects unknown angle at the route layer (400)
 *   14. Keywords array is stored and returned correctly
 *   15. scheduledFor is accepted as ISO string and round-trips
 *
 * Uses real embedded Postgres so the FK, UNIQUE, and CHECK constraints
 * in 0086_content_briefs.sql are exercised end-to-end.
 *
 * Fixture invariants (from CLAUDE.md):
 *   - startEmbeddedPostgresTestDatabase returns { connectionString, cleanup }
 *   - Tests must call TRUNCATE … CASCADE in beforeEach (not between describes)
 *   - Never chain .where(a).where(b) in source code — use and(eq, eq)
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contentBriefRoutes } from "../routes/content-briefs.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping content-briefs tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function buildBaseApp(companyId: string) {
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
  return app;
}

describeEmbeddedPostgres("Content Briefs API", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-content-briefs-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes content_briefs via FK ON DELETE RESTRICT. Truncating
    // companies CASCADE also cascades to content_briefs. Use a single
    // TRUNCATE CASCADE on companies — Postgres will cascade to all referencing
    // tables regardless of their FK ON DELETE behavior.
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // issuePrefix has a UNIQUE constraint — each company needs a distinct prefix.
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
  });

  function makeApp(forCompanyId: string = companyId) {
    const app = buildBaseApp(forCompanyId);
    app.use("/api", contentBriefRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── POST create ────────────────────────────────────────────────────────────

  it("POST creates a brief with status=draft by default", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({
        title: "Onboarding for SaaS founders",
        thesis: "Good onboarding = better activation",
        audience: "SaaS founders 5k-100k MRR",
        angle: "how-to",
        keywords: ["onboarding", "SaaS"],
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe("Onboarding for SaaS founders");
    expect(res.body.thesis).toBe("Good onboarding = better activation");
    expect(res.body.status).toBe("draft");
    expect(res.body.audience).toBe("SaaS founders 5k-100k MRR");
    expect(res.body.angle).toBe("how-to");
    expect(res.body.keywords).toEqual(["onboarding", "SaaS"]);
    expect(res.body.companyId).toBe(companyId);
  });

  it("POST returns 400 for empty title", async () => {
    const app = makeApp();
    await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "", thesis: "Some thesis" })
      .expect(400);
  });

  it("POST returns 400 for unknown angle value", async () => {
    const app = makeApp();
    await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Test", thesis: "Thesis", angle: "viral-meme" })
      .expect(400);
  });

  it("POST stores scheduledFor and returns as ISO string", async () => {
    const app = makeApp();
    const future = new Date("2026-06-01T09:00:00.000Z").toISOString();
    const res = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Scheduled post", thesis: "Future content", scheduledFor: future })
      .expect(201);

    expect(res.body.scheduledFor).toBe(future);
  });

  // ── GET list ───────────────────────────────────────────────────────────────

  it("GET list returns newest-first", async () => {
    const app = makeApp();

    await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "First", thesis: "T1" })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Second", thesis: "T2" })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/content-briefs`)
      .expect(200);

    expect(res.body.briefs).toHaveLength(2);
    // Newest first: "Second" was inserted after "First"
    expect(res.body.briefs[0].title).toBe("Second");
    expect(res.body.briefs[1].title).toBe("First");
    expect(res.body.meta.count).toBe(2);
  });

  it("GET list ?status= filters correctly", async () => {
    const app = makeApp();

    await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Draft brief", thesis: "T1" })
      .expect(201);

    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Will be researching", thesis: "T2" })
      .expect(201);

    // Transition to researching
    await request(app)
      .post(`/api/companies/${companyId}/content-briefs/${created.body.id}/transition`)
      .send({ status: "researching" })
      .expect(200);

    const res = await request(app)
      .get(`/api/companies/${companyId}/content-briefs?status=researching`)
      .expect(200);

    expect(res.body.briefs).toHaveLength(1);
    expect(res.body.briefs[0].title).toBe("Will be researching");
  });

  it("GET list returns 400 for invalid status value", async () => {
    const app = makeApp();
    await request(app)
      .get(`/api/companies/${companyId}/content-briefs?status=flying`)
      .expect(400);
  });

  // ── GET single ────────────────────────────────────────────────────────────

  it("GET single returns 200 with full serialized brief", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Solo brief", thesis: "Single fetch" })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/content-briefs/${created.body.id}`)
      .expect(200);

    expect(res.body.id).toBe(created.body.id);
    expect(res.body.title).toBe("Solo brief");
  });

  it("GET single returns 404 for unknown id", async () => {
    const app = makeApp();
    await request(app)
      .get(
        `/api/companies/${companyId}/content-briefs/00000000-0000-0000-0000-000000000000`,
      )
      .expect(404);
  });

  it("GET single returns 404 when brief belongs to a different company (tenant isolation)", async () => {
    // Create a brief under company A
    const appA = makeApp(companyId);
    const created = await request(appA)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Company A brief", thesis: "Private" })
      .expect(201);

    // Attempt to read it via company B's path — must 404, not 200
    const appB = makeApp(otherCompanyId);
    await request(appB)
      .get(`/api/companies/${otherCompanyId}/content-briefs/${created.body.id}`)
      .expect(404);
  });

  // ── PATCH update ──────────────────────────────────────────────────────────

  it("PATCH updates mutable fields and advances updatedAt", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Original title", thesis: "Original thesis" })
      .expect(201);

    const originalUpdatedAt = created.body.updatedAt as string;

    // Small delay so updatedAt can advance
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app)
      .patch(
        `/api/companies/${companyId}/content-briefs/${created.body.id}`,
      )
      .send({
        title: "Updated title",
        audience: "CTOs",
        keywords: ["saas", "growth"],
      })
      .expect(200);

    expect(res.body.title).toBe("Updated title");
    expect(res.body.audience).toBe("CTOs");
    expect(res.body.keywords).toEqual(["saas", "growth"]);
    expect(res.body.thesis).toBe("Original thesis"); // unchanged
    expect(res.body.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("PATCH returns 404 for unknown brief id", async () => {
    const app = makeApp();
    await request(app)
      .patch(
        `/api/companies/${companyId}/content-briefs/00000000-0000-0000-0000-000000000000`,
      )
      .send({ title: "Ghost edit" })
      .expect(404);
  });

  it("PATCH returns 404 when brief belongs to a different company (tenant isolation)", async () => {
    const appA = makeApp(companyId);
    const created = await request(appA)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Private brief", thesis: "For A only" })
      .expect(201);

    const appB = makeApp(otherCompanyId);
    await request(appB)
      .patch(
        `/api/companies/${otherCompanyId}/content-briefs/${created.body.id}`,
      )
      .send({ title: "Cross-tenant attack" })
      .expect(404);
  });

  // ── POST /transition ──────────────────────────────────────────────────────

  it("transition: draft → researching → drafting → review succeeds", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Flow test", thesis: "Full pipeline" })
      .expect(201);
    const id = created.body.id as string;

    const t1 = await request(app)
      .post(`/api/companies/${companyId}/content-briefs/${id}/transition`)
      .send({ status: "researching" })
      .expect(200);
    expect(t1.body.status).toBe("researching");

    const t2 = await request(app)
      .post(`/api/companies/${companyId}/content-briefs/${id}/transition`)
      .send({ status: "drafting" })
      .expect(200);
    expect(t2.body.status).toBe("drafting");

    const t3 = await request(app)
      .post(`/api/companies/${companyId}/content-briefs/${id}/transition`)
      .send({ status: "review" })
      .expect(200);
    expect(t3.body.status).toBe("review");
  });

  it("transition: rejects invalid hop draft → published (400)", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Invalid hop", thesis: "Jumping states" })
      .expect(201);

    await request(app)
      .post(
        `/api/companies/${companyId}/content-briefs/${created.body.id}/transition`,
      )
      .send({ status: "published" })
      .expect(400);
  });

  it("transition: review can kick back to draft (bidirectional)", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Kickback", thesis: "Needs revision" })
      .expect(201);
    const id = created.body.id as string;

    // draft → researching → drafting → review → draft
    for (const status of ["researching", "drafting", "review"] as const) {
      await request(app)
        .post(`/api/companies/${companyId}/content-briefs/${id}/transition`)
        .send({ status })
        .expect(200);
    }

    const res = await request(app)
      .post(`/api/companies/${companyId}/content-briefs/${id}/transition`)
      .send({ status: "draft" })
      .expect(200);
    expect(res.body.status).toBe("draft");
  });

  it("transition returns 404 for unknown brief id", async () => {
    const app = makeApp();
    await request(app)
      .post(
        `/api/companies/${companyId}/content-briefs/00000000-0000-0000-0000-000000000000/transition`,
      )
      .send({ status: "researching" })
      .expect(404);
  });

  it("transition returns 404 when brief belongs to another company", async () => {
    const appA = makeApp(companyId);
    const created = await request(appA)
      .post(`/api/companies/${companyId}/content-briefs`)
      .send({ title: "Private brief", thesis: "For A" })
      .expect(201);

    const appB = makeApp(otherCompanyId);
    await request(appB)
      .post(
        `/api/companies/${otherCompanyId}/content-briefs/${created.body.id}/transition`,
      )
      .send({ status: "researching" })
      .expect(404);
  });

  // ── DB-level constraint enforcement ───────────────────────────────────────

  it("DB CHECK constraint rejects unknown status via raw SQL", async () => {
    // Bypass Zod to verify defense-in-depth at the DB layer.
    await expect(
      db.execute(
        sql`INSERT INTO "content_briefs" ("company_id","title","thesis","status")
            VALUES (${companyId}, 'Raw insert', 'Thesis', 'viral')`,
      ),
    ).rejects.toThrow();
  });
});
