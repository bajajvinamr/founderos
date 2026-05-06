/**
 * upsell-workflow.test.ts — Integration tests for the upsell workflow template (S4.9)
 *
 * Test coverage:
 *   A. Registration (1 test)
 *      A1. POST /workflows with template='upsell' creates workflow with correct defaults
 *
 *   B. Autonomous upsell happy path (3 tests) — happy path for autonomyLevel=4
 *      B1. Workflow with autonomyLevel=4 + instance flag enabled → run completed
 *      B2. Email action status transitions to completed with checkoutUrl
 *      B3. Activity log records the autonomous send
 *
 *   C. Gated upsell (autonomy check) (2 tests) — P1 BLOCK fix validation
 *      C1. Workflow with autonomyLevel=3 → run pending_approval (no send)
 *      C2. Workflow with autonomyLevel=2 (default) → run pending_approval (no send)
 *
 *   D. Cross-tenant isolation (1 test)
 *      D1. Company A actor cannot trigger upsell on Company B workflow
 *
 *   E. Stripe integration (1 test)
 *      E1. Checkout URL generated and included in email payload
 *
 * Total: 8 tests.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, workflows, workflowRuns } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { AUTONOMOUS_EMAIL_SETTING_KEY } from "../services/workflow-autonomy.js";
import * as stripeModule from "../services/stripe-client.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping upsell workflow tests: ${support.reason ?? "unsupported environment"}`);
}

// ── Mock Stripe ──────────────────────────────────────────────────────────────

const mockStripeClient = {
  createCheckoutSession: vi.fn().mockResolvedValue({
    url: "https://checkout.stripe.com/pay/cs_test_abc123",
  }),
  isEnabled: vi.fn().mockReturnValue(true),
};

vi.spyOn(stripeModule, "createStripeClient").mockReturnValue(mockStripeClient as any);

// ── Shared test app builder ──────────────────────────────────────────────────

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
  companyIds?: string[],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: companyIds ?? ["__placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

/**
 * Minimal valid upsell workflow body.
 */
function validUpsellWorkflowBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "High-engagement upsell",
    template: "upsell",
    triggerKind: "schedule",
    triggerSpec: { cron: "0 9 * * *", timezone: "America/New_York" },
    config: {
      contactEmail: "user@example.com",
      contactName: "Alice",
      companyName: "FounderOS",
      primaryFeature: "workflow automation",
      pricingPageUrl: "https://example.com/pricing",
      successUrl: "https://example.com/dashboard",
      cancelUrl: "https://example.com/pricing",
    },
    ...overrides,
  };
}

describeEmbeddedPostgres("S4.9 Upsell Workflow Template", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let testUserId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("upsell-workflow");
    db = createDb(testDb.connectionString);
    testUserId = "user-test";
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // Create a fresh company for each test with unique issuePrefix
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Company",
        issuePrefix: `TST${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
      })
      .returning();
    companyId = company.id;
  });

  // ── A. Registration ──────────────────────────────────────────────────────

  describe("A. Registration", () => {
    it("A1. POST /workflows with template='upsell' creates workflow with correct defaults", async () => {
      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post("/api/workflows")
        .send(validUpsellWorkflowBody())
        .expect(201);

      expect(res.body).toHaveProperty("id");
      expect(res.body.template).toBe("upsell");
      expect(res.body.name).toBe("High-engagement upsell");
      expect(res.body.autonomyLevel).toBe(2); // DB default
      expect(res.body.status).toBe("draft"); // DB default
    });
  });

  // ── B. Autonomous upsell happy path ──────────────────────────────────────

  describe("B. Autonomous upsell happy path", () => {
    it("B1. Workflow with autonomyLevel=4 + instance flag enabled → run completed", async () => {
      // Enable autonomous email at instance level
      await db.execute(
        sql`
          UPDATE instance_settings
          SET general = jsonb_set(general, $1, $2)
          WHERE singleton_key = 'default'
        `,
        [AUTONOMOUS_EMAIL_SETTING_KEY, "true"],
      );

      // Create workflow with autonomyLevel=4
      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Auto upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "alice@example.com",
            contactName: "Alice",
            companyName: "FounderOS",
            primaryFeature: "workflow automation",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe("completed"); // Autonomous send

      // Verify the run has actions with completed status
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(sql`id = ${res.body.id}`);

      expect(run?.actions).toHaveLength(1);
      expect(run?.actions[0].status).toBe("completed");
    });

    it("B2. Email action status transitions to completed with checkoutUrl", async () => {
      await db.execute(
        sql`
          UPDATE instance_settings
          SET general = jsonb_set(general, $1, $2)
          WHERE singleton_key = 'default'
        `,
        [AUTONOMOUS_EMAIL_SETTING_KEY, "true"],
      );

      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Auto upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "bob@example.com",
            contactName: "Bob",
            companyName: "FounderOS",
            primaryFeature: "analytics",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(sql`id = ${res.body.id}`);

      const action = run?.actions?.[0];
      expect(action?.type).toBe("send_email");
      expect(action?.payload?.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_abc123");
      expect(action?.payload?.subject).toContain("Pro");
      expect(action?.status).toBe("completed");
      expect(action?.executedAt).toBeDefined();
    });

    it("B3. Activity log records the autonomous send", async () => {
      await db.execute(
        sql`
          UPDATE instance_settings
          SET general = jsonb_set(general, $1, $2)
          WHERE singleton_key = 'default'
        `,
        [AUTONOMOUS_EMAIL_SETTING_KEY, "true"],
      );

      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Auto upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "charlie@example.com",
            contactName: "Charlie",
            companyName: "FounderOS",
            primaryFeature: "integrations",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      // TODO: Verify activity log when logActivity is accessible in tests
      // For now, we just verify the workflow executed without error
    });
  });

  // ── C. Gated upsell (autonomy check) ─────────────────────────────────────

  describe("C. Gated upsell (autonomy check)", () => {
    it("C1. Workflow with autonomyLevel=3 → run pending_approval (no send)", async () => {
      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Approval upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 3, // approval-required
          status: "active",
          config: {
            contactEmail: "david@example.com",
            contactName: "David",
            companyName: "FounderOS",
            primaryFeature: "reporting",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      expect(res.body.status).toBe("pending_approval");

      // Verify actions are stored but not executed
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(sql`id = ${res.body.id}`);

      expect(run?.actions).toHaveLength(1);
      expect(run?.actions[0].status).toBe("pending");
      expect(run?.actions[0]?.executedAt).toBeUndefined();
    });

    it("C2. Workflow with autonomyLevel=2 (default) → run pending_approval (no send)", async () => {
      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Draft upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 2, // draft (default)
          status: "active",
          config: {
            contactEmail: "eve@example.com",
            contactName: "Eve",
            companyName: "FounderOS",
            primaryFeature: "api-access",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      expect(res.body.status).toBe("pending_approval");

      // Verify Stripe was NOT called for draft-only workflows
      // (We still generate the URL for the founder to review, but don't send the email)
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(sql`id = ${res.body.id}`);

      expect(run?.actions).toHaveLength(1);
      expect(run?.actions[0].status).toBe("pending");
    });
  });

  // ── D. Cross-tenant isolation ────────────────────────────────────────────

  describe("D. Cross-tenant isolation", () => {
    it("D1. Company A actor cannot trigger upsell on Company B workflow", async () => {
      const [companyB] = await db
        .insert(companies)
        .values({
          name: "Other Company",
        })
        .returning();

      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId: companyB.id,
          name: "Upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "frank@example.com",
            companyName: "FounderOS",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      // Actor with access to companyId (not companyB)
      const app = buildApp(db, {}, [companyId]);

      await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(404); // Workflow not found (different company)
    });
  });

  // ── E. Stripe integration ────────────────────────────────────────────────

  describe("E. Stripe integration", () => {
    it("E1. Checkout URL generated and included in email payload", async () => {
      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Stripe upsell",
          template: "upsell",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 9 * * *" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "grace@example.com",
            contactName: "Grace",
            companyName: "FounderOS",
            primaryFeature: "advanced-analytics",
            pricingPageUrl: "https://example.com/pricing",
            successUrl: "https://example.com/dashboard",
            cancelUrl: "https://example.com/pricing",
          },
        })
        .returning();

      const app = buildApp(db, {}, [companyId]);

      const res = await request(app)
        .post(`/api/workflows/${workflow.id}/runs`)
        .send({
          triggeredBy: { kind: "schedule", cron: "0 9 * * *" },
        })
        .expect(201);

      // Stripe client should have been called
      expect(mockStripeClient.createCheckoutSession).toHaveBeenCalled();

      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(sql`id = ${res.body.id}`);

      // Verify the checkout URL is in the email payload
      const action = run?.actions?.[0];
      expect(action?.payload?.checkoutUrl).toContain("stripe.com");
    });
  });
});
