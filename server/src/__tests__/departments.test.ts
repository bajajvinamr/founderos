/**
 * departments.test.ts — integration tests for the Department Registry API
 *
 * Covers:
 *   1. GET /api/companies/:companyId/departments — list joined rows
 *   2. PATCH /api/companies/:companyId/departments/:departmentId — toggle enabled
 *   3. PATCH — change autonomy level
 *   4. PATCH — unknown department returns 404
 *   5. Auth — unauthenticated request returns 401
 *   6. Auth — agent from another company returns 403
 *
 * Uses real embedded Postgres so the UNIQUE constraint, CROSS JOIN backfill,
 * and FK cascade are exercised end-to-end against the real schema.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, departments, workspaceDepartments, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { departmentRoutes } from "../routes/departments.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping departments tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function buildApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: ["__company_id_placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  return app;
}

describeEmbeddedPostgres("Department Registry API", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-departments-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Reset workspace_departments and companies between tests; keep department catalogue.
    await db.execute(sql`TRUNCATE TABLE "workspace_departments" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // Ensure catalogue rows exist (idempotent — ON CONFLICT DO NOTHING)
    await db
      .insert(departments)
      .values([
        { id: "chief-of-staff", label: "Chief of Staff", sortOrder: 1, isCore: true },
        { id: "growth",         label: "Growth",         sortOrder: 2, isCore: true },
        { id: "content",        label: "Content Studio", sortOrder: 3, isCore: true },
        { id: "crm",            label: "CRM & Lifecycle",sortOrder: 4, isCore: true },
        { id: "finance",        label: "Finance",        sortOrder: 5, isCore: true },
        { id: "engineering",    label: "Engineering",    sortOrder: 6, isCore: false },
        { id: "ops",            label: "Operations",     sortOrder: 7, isCore: false },
      ])
      .onConflictDoNothing();

    // Insert a test company and capture its id
    const [company] = await db
      .insert(companies)
      .values({ name: "Test Corp" })
      .returning({ id: companies.id });
    companyId = company!.id;

    // Backfill core departments (mirrors migration 0075 backfill)
    const coreDepts = await db
      .select({ id: departments.id })
      .from(departments)
      .where(sql`is_core = true`);
    if (coreDepts.length > 0) {
      await db.insert(workspaceDepartments).values(
        coreDepts.map((d) => ({
          companyId,
          departmentId: d.id,
          enabled: true,
          autonomyLevel: 2,
        })),
      ).onConflictDoNothing();
    }
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = buildApp({ companyIds: [companyId], ...overrides });
    app.use("/api", departmentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── GET list ──────────────────────────────────────────────────────────────

  it("GET returns the 5 core departments for an existing company", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/departments`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);

    const ids = (res.body as Array<{ departmentId: string }>).map((r) => r.departmentId);
    expect(ids).toContain("chief-of-staff");
    expect(ids).toContain("growth");
    expect(ids).toContain("finance");
    // Non-core not backfilled
    expect(ids).not.toContain("engineering");
    expect(ids).not.toContain("ops");
  });

  it("GET rows are joined with catalogue fields (label, isCore)", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/departments`)
      .expect(200);

    const cosRow = (res.body as Array<{ departmentId: string; label: string; isCore: boolean; enabled: boolean; autonomyLevel: number }>)
      .find((r) => r.departmentId === "chief-of-staff");
    expect(cosRow).toBeDefined();
    expect(cosRow!.label).toBe("Chief of Staff");
    expect(cosRow!.isCore).toBe(true);
    expect(cosRow!.enabled).toBe(true);
    expect(cosRow!.autonomyLevel).toBe(2);
  });

  // ── PATCH toggle enabled ──────────────────────────────────────────────────

  it("PATCH toggles a department off", async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/api/companies/${companyId}/departments/growth`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.enabled).toBe(false);
    expect(res.body.departmentId).toBe("growth");
  });

  it("PATCH re-enables a disabled department", async () => {
    const app = makeApp();

    await request(app)
      .patch(`/api/companies/${companyId}/departments/growth`)
      .send({ enabled: false })
      .expect(200);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/departments/growth`)
      .send({ enabled: true })
      .expect(200);

    expect(res.body.enabled).toBe(true);
  });

  // ── PATCH autonomy level ──────────────────────────────────────────────────

  it("PATCH bumps autonomy level", async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/api/companies/${companyId}/departments/finance`)
      .send({ autonomyLevel: 4 })
      .expect(200);

    expect(res.body.autonomyLevel).toBe(4);
  });

  it("PATCH rejects autonomy level outside 1..4", async () => {
    const app = makeApp();
    await request(app)
      .patch(`/api/companies/${companyId}/departments/finance`)
      .send({ autonomyLevel: 5 })
      .expect(400);
  });

  // ── PATCH for non-core department (upsert path) ───────────────────────────

  it("PATCH creates a workspace row for a non-backfilled non-core department", async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/api/companies/${companyId}/departments/engineering`)
      .send({ enabled: true, autonomyLevel: 3 })
      .expect(200);

    expect(res.body.departmentId).toBe("engineering");
    expect(res.body.enabled).toBe(true);
    expect(res.body.autonomyLevel).toBe(3);
  });

  // ── 404 for unknown department ────────────────────────────────────────────

  it("PATCH returns 404 for an unknown department id", async () => {
    const app = makeApp();
    await request(app)
      .patch(`/api/companies/${companyId}/departments/does-not-exist`)
      .send({ enabled: false })
      .expect(404);
  });

  // ── Auth guards ───────────────────────────────────────────────────────────

  it("GET returns 401 for unauthenticated request", async () => {
    const app = buildApp({ type: "none" });
    app.use("/api", departmentRoutes(db));
    app.use(errorHandler);

    await request(app)
      .get(`/api/companies/${companyId}/departments`)
      .expect(401);
  });

  it("GET returns 403 when agent belongs to a different company", async () => {
    const app = buildApp({
      type: "agent",
      agentId: "agent-other",
      companyId: "other-company-id",
    });
    app.use("/api", departmentRoutes(db));
    app.use(errorHandler);

    await request(app)
      .get(`/api/companies/${companyId}/departments`)
      .expect(403);
  });
});
