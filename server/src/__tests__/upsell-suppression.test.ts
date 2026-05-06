/**
 * upsell-suppression.test.ts — S4.8 prerequisite #196 layer 3e.
 *
 * Mirror of onboarding-emails-suppression / activation-nudge-suppression for
 * the upsell template (topic="upsell"). Exercises:
 *
 *   - URL seam: bodyText + bodyHtml contain /u/customer/<token>
 *   - Skip seam: pre-send isSuppressed() on topic="upsell" → status="skipped"
 *   - topic="all" master switch
 *   - Unrelated topic does NOT skip
 *
 * Upsell creates a Stripe checkout URL via createStripeClient — the embedded
 * test stub returns a deterministic checkout URL when STRIPE_SECRET_KEY is
 * unset (or set to a test value), so we don't need to mock the Stripe SDK.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  customerEmailSuppressions,
  instanceSettings,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createWorkflow,
  createWorkflowRun,
  executeWorkflowTemplate,
  getWorkflowRun,
} from "../services/workflows.js";
import * as stripeModule from "../services/stripe-client.js";

// Mock Stripe checkout-session creation — returns a deterministic URL so the
// test doesn't need a real STRIPE_SECRET_KEY. Mirrors the pattern in
// upsell-workflow.test.ts.
const mockStripeClient = {
  createCheckoutSession: vi.fn().mockResolvedValue({
    url: "https://checkout.stripe.com/pay/cs_test_supp",
  }),
  isEnabled: vi.fn().mockReturnValue(true),
};
vi.spyOn(stripeModule, "createStripeClient").mockReturnValue(
  mockStripeClient as unknown as ReturnType<typeof stripeModule.createStripeClient>,
);

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const APP_URL_ENV = "APP_URL";
const STRIPE_KEY_ENV = "STRIPE_SECRET_KEY";
const TEST_SECRET = "test-upsell-supp-secret-c4f6a8b2-9d3e-4f17-bc05-a9b1d2c3e4f5";
const TEST_APP_URL = "https://founderos.test";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping upsell-suppression tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("upsell — suppression skip + URL injection", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let prevSecret: string | undefined;
  let prevAppUrl: string | undefined;
  let prevStripeKey: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env[SECRET_ENV];
    prevAppUrl = process.env[APP_URL_ENV];
    prevStripeKey = process.env[STRIPE_KEY_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
    process.env[APP_URL_ENV] = TEST_APP_URL;
    // Force the stub Stripe client (no real network call).
    delete process.env[STRIPE_KEY_ENV];

    testDb = await startEmbeddedPostgresTestDatabase("upsell-supp");
    db = createDb(testDb.connectionString);

    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: { "lifecycle_crm.allow_autonomous_email": true },
        experimental: {},
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          general: { "lifecycle_crm.allow_autonomous_email": true },
        },
      });
  });

  afterAll(async () => {
    await testDb.cleanup();
    if (prevSecret === undefined) {
      delete process.env[SECRET_ENV];
    } else {
      process.env[SECRET_ENV] = prevSecret;
    }
    if (prevAppUrl === undefined) {
      delete process.env[APP_URL_ENV];
    } else {
      process.env[APP_URL_ENV] = prevAppUrl;
    }
    if (prevStripeKey !== undefined) {
      process.env[STRIPE_KEY_ENV] = prevStripeKey;
    }
  });

  beforeEach(async () => {
    await db.delete(customerEmailSuppressions);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Upsell Supp Co",
        instanceId: "test-instance",
        issuePrefix: `US${suffix}`,
      })
      .returning();
    companyId = company.id;
  });

  async function runFor(contactEmail: string) {
    const workflow = await createWorkflow(db, {
      companyId,
      actorType: "user",
      actorId: "founder-1",
      data: {
        name: "Upsell test",
        template: "upsell",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 12 * * *" },
        autonomyLevel: 4,
        status: "active",
        config: {
          contactEmail,
          contactName: "Alice",
          companyName: "FounderOS",
          primaryFeature: "workflow automation",
          pricingPageUrl: "https://founderos.test/pricing",
          successUrl: "https://founderos.test/dashboard?upgraded=1",
          cancelUrl: "https://founderos.test/pricing?cancelled=1",
        },
      },
    });

    const run = await createWorkflowRun(db, {
      companyId,
      workflowId: workflow.id,
      actorType: "system",
      actorId: "trigger-engine",
      data: {
        status: "running",
        triggeredBy: { source: "scheduler", event: "tick" },
        actions: [],
      },
    });

    await executeWorkflowTemplate(db, workflow, run);
    return await getWorkflowRun(db, companyId, run.id);
  }

  describe("URL seam (3e)", () => {
    it("embeds /u/customer/<token> URL in bodyText + bodyHtml when not suppressed", async () => {
      const updated = await runFor("alice@example.com");
      expect(updated?.status).toBe("completed");
      const actions = updated?.actions as Array<{
        status: string;
        payload: { bodyText: string; bodyHtml: string };
      }>;
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("completed");

      const urlPattern =
        /https:\/\/founderos\.test\/u\/customer\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
      expect(actions[0].payload.bodyText).toMatch(urlPattern);
      expect(actions[0].payload.bodyHtml).toMatch(urlPattern);
    });
  });

  describe("Skip seam (3e)", () => {
    it("sets status='skipped' + skipReason when contact has 'upsell' suppression", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "bob@example.com",
        topic: "upsell",
        reason: "user_unsubscribe",
        metadata: {},
      });

      const updated = await runFor("bob@example.com");
      // Skipped is success-shaped; run is "completed".
      expect(updated?.status).toBe("completed");
      const actions = updated?.actions as Array<{
        status: string;
        payload: Record<string, unknown>;
      }>;
      expect(actions[0].status).toBe("skipped");
      expect(actions[0].payload.skipReason).toBe("customer_email_suppressed");
    });

    it("respects topic='all' master switch", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "carol@example.com",
        topic: "all",
        reason: "user_unsubscribe",
        metadata: {},
      });

      const updated = await runFor("carol@example.com");
      const actions = updated?.actions as Array<{ status: string }>;
      expect(actions[0].status).toBe("skipped");
    });

    it("does NOT skip when only an unrelated topic is suppressed", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "dave@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
        metadata: {},
      });

      const updated = await runFor("dave@example.com");
      const actions = updated?.actions as Array<{ status: string }>;
      expect(actions[0].status).toBe("completed");
    });
  });
});
