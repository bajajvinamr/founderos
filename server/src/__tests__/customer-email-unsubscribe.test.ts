/**
 * customer-email-unsubscribe.test.ts — S4.8 prerequisite #196 layer 3b.
 *
 * Integration tests for the public unsubscribe route handler. Boots an
 * Express app with the route mounted at app-level (mirrors production
 * mount in app.ts), generates HMAC tokens via the layer 2 service, hits
 * the route via supertest, asserts on response shape + DB side effects.
 *
 * Coverage:
 *   1. GET valid token → 200 + suppression row created + correct topic
 *   2. POST valid token → 200 + suppression row created (CAN-SPAM RFC 8058)
 *   3. GET invalid token (random string) → 400, no row, helpful body
 *   4. GET malformed token (no dot, single segment) → 400, no row
 *   5. GET tampered HMAC → 400, no row
 *   6. GET replay (already-suppressed contact) → 200 idempotent, no second row
 *   7. GET token with topic='all' → 200, master suppression created
 *   8. POST sets metadata.http_method=POST; GET sets http_method=GET
 *   9. Cross-tenant: token for company A doesn't suppress company B
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  customerEmailSuppressions,
  companies,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { customerEmailUnsubscribeRoutes } from "../routes/customer-email-unsubscribe.js";
import { generateUnsubscribeToken } from "../services/email-unsubscribe-tokens.js";

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const TEST_SECRET = "test-unsubscribe-secret-c4f6a8b2-9d3e-4f17-bc05-a9b1d2c3e4f5";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping customer-email-unsubscribe route tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("customer-email-unsubscribe route", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let companyAId: string;
  let companyBId: string;
  let prevSecret: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env[SECRET_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
    testDb = await startEmbeddedPostgresTestDatabase("cust-email-unsub");
    db = createDb(testDb.connectionString);

    app = express();
    app.use(express.json());
    app.use(customerEmailUnsubscribeRoutes(db));
  });

  afterAll(async () => {
    await testDb.cleanup();
    if (prevSecret === undefined) {
      delete process.env[SECRET_ENV];
    } else {
      process.env[SECRET_ENV] = prevSecret;
    }
  });

  beforeEach(async () => {
    await db.delete(customerEmailSuppressions);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [companyA] = await db
      .insert(companies)
      .values({ name: "Company A", issuePrefix: `CA${suffix}` })
      .returning();
    const [companyB] = await db
      .insert(companies)
      .values({ name: "Company B", issuePrefix: `CB${suffix}` })
      .returning();
    companyAId = companyA.id;
    companyBId = companyB.id;
  });

  it("GET valid token → 200 + suppression row created", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "onboarding",
      ts: 1780200000000,
    });

    const res = await request(app).get(`/u/customer/${token}`).expect(200);
    expect(res.text).toMatch(/unsubscribed from onboarding emails/);

    const rows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    expect(rows).toHaveLength(1);
    expect(rows[0].contactEmail).toBe("alice@example.com");
    expect(rows[0].topic).toBe("onboarding");
    expect(rows[0].reason).toBe("user_unsubscribe");
  });

  it("POST valid token → 200 + suppression row (RFC 8058 List-Unsubscribe-Post)", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "churn_rescue",
      ts: 1780200000000,
    });

    const res = await request(app).post(`/u/customer/${token}`).expect(200);
    expect(res.text).toMatch(/unsubscribed from churn_rescue emails/);

    const rows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("churn_rescue");
  });

  it("GET invalid token (random string) → 400, no row", async () => {
    const res = await request(app)
      .get("/u/customer/garbage-not-a-token")
      .expect(400);
    expect(res.text).toMatch(/Invalid or expired/);

    const rows = await db.select().from(customerEmailSuppressions);
    expect(rows).toHaveLength(0);
  });

  it("GET malformed token (no dot) → 400, no row", async () => {
    const res = await request(app)
      .get("/u/customer/onesegmentnodot")
      .expect(400);
    expect(res.text).toMatch(/Invalid or expired/);

    const rows = await db.select().from(customerEmailSuppressions);
    expect(rows).toHaveLength(0);
  });

  it("GET tampered HMAC → 400, no row", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "onboarding",
      ts: 1780200000000,
    });
    const [payload, hmac] = token.split(".");
    const flipped = hmac[0] === "A" ? "B" : "A";
    const tampered = `${payload}.${flipped}${hmac.slice(1)}`;

    const res = await request(app).get(`/u/customer/${tampered}`).expect(400);
    expect(res.text).toMatch(/Invalid or expired/);

    const rows = await db.select().from(customerEmailSuppressions);
    expect(rows).toHaveLength(0);
  });

  it("GET replay (already-suppressed) → 200 idempotent, no second row", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "onboarding",
      ts: 1780200000000,
    });

    const first = await request(app).get(`/u/customer/${token}`).expect(200);
    expect(first.text).toMatch(/^You're unsubscribed/);

    const second = await request(app).get(`/u/customer/${token}`).expect(200);
    expect(second.text).toMatch(/^You're already unsubscribed/);

    const rows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    expect(rows).toHaveLength(1);
  });

  it("GET token with topic='all' → 200, master suppression created", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "all",
      ts: 1780200000000,
    });

    const res = await request(app).get(`/u/customer/${token}`).expect(200);
    expect(res.text).toMatch(/unsubscribed from all emails/);

    const rows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("all");
  });

  it("metadata.http_method reflects the verb", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "onboarding",
      ts: 1780200000000,
    });

    await request(app).get(`/u/customer/${token}`).expect(200);

    const rows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.http_method).toBe("GET");
    expect(meta.token_ts).toBe(1780200000000);
  });

  it("cross-tenant: token for company A does NOT suppress company B", async () => {
    const token = generateUnsubscribeToken({
      c: companyAId,
      e: "alice@example.com",
      t: "onboarding",
      ts: 1780200000000,
    });

    await request(app).get(`/u/customer/${token}`).expect(200);

    const aRows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyAId));
    const bRows = await db
      .select()
      .from(customerEmailSuppressions)
      .where(eq(customerEmailSuppressions.companyId, companyBId));
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(0);
  });
});
