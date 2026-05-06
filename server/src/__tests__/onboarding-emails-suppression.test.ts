/**
 * onboarding-emails-suppression.test.ts — S4.8 prerequisite #196 layer 3c-2.
 *
 * Integration tests for the two seams that landed in the onboarding email
 * template across layers 3c-1 and 3c-2:
 *
 *   - Skip seam (3c-1): pre-send isSuppressed() check sets action.status="skipped"
 *     and stops the transport.send(). Already covered structurally by layer 3a's
 *     unit tests, but exercised here through the WHOLE template path with a
 *     real workflow run + autonomous send.
 *
 *   - URL seam (3c-2): every email body (text + html) embeds an HMAC-signed
 *     unsubscribe URL of shape https://<host>/u/customer/<token>. Asserted via
 *     regex on action.payload.bodyText and action.payload.bodyHtml.
 *
 * The tests use autonomyLevel=4 + lifecycle_crm.allow_autonomous_email=true to
 * route through sendOnboardingEmails(), where the suppression check lives.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const APP_URL_ENV = "APP_URL";
const TEST_SECRET = "test-onboarding-supp-secret-c4f6a8b2-9d3e-4f17-bc05-a9b1d2";
const TEST_APP_URL = "https://founderos.test";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping onboarding-emails-suppression tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("onboarding-emails — suppression skip + URL injection", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let prevSecret: string | undefined;
  let prevAppUrl: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env[SECRET_ENV];
    prevAppUrl = process.env[APP_URL_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
    process.env[APP_URL_ENV] = TEST_APP_URL;

    testDb = await startEmbeddedPostgresTestDatabase("onboarding-supp");
    db = createDb(testDb.connectionString);

    // Enable the autonomous-email flag so the template actually sends instead
    // of routing to pending_approval. The flag lives in instance_settings.general
    // under key 'lifecycle_crm.allow_autonomous_email'. The default row is
    // created lazily by instance-settings service in production — in tests we
    // upsert it directly so the workflow-autonomy gate's read sees the flag.
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
  });

  beforeEach(async () => {
    await db.delete(customerEmailSuppressions);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Onboarding Supp Co",
        instanceId: "test-instance",
        issuePrefix: `OS${suffix}`,
      })
      .returning();
    companyId = company.id;
  });

  describe("URL seam (3c-2)", () => {
    it("embeds /u/customer/<token> URL in every email body (text + html)", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Onboarding URL injection",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "alice@example.com",
            contactName: "Alice",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.test/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      expect(updatedRun?.status).toBe("completed");
      const actions = updatedRun?.actions as Array<{
        status: string;
        payload: { bodyText: string; bodyHtml: string; day: number };
      }>;
      expect(actions).toHaveLength(3);

      // Every email body must contain a /u/customer/<token> URL whose token is
      // base64url(payload).base64url(hmac).
      const urlPattern =
        /https:\/\/founderos\.test\/u\/customer\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

      for (const action of actions) {
        expect(action.status).toBe("completed");
        expect(action.payload.bodyText).toMatch(urlPattern);
        expect(action.payload.bodyHtml).toMatch(urlPattern);
      }

      // All 3 emails share the SAME unsubscribe URL — recipient + topic are
      // identical across the sequence, so the token is deterministically equal.
      // This is correct behavior; founders see one stable opt-out link.
      const extractUrl = (s: string) => s.match(urlPattern)?.[0];
      const urls = actions.map((a) => extractUrl(a.payload.bodyText));
      expect(new Set(urls).size).toBe(1);
    });
  });

  describe("Skip seam (3c-1) — exercised through full template path", () => {
    it("sets action.status=skipped + skipReason when contact has 'onboarding' suppression", async () => {
      // Pre-suppress the contact for the onboarding topic.
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "bob@example.com",
        topic: "onboarding",
        reason: "user_unsubscribe",
        metadata: { source: "test-fixture" },
      });

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Onboarding skip path",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "bob@example.com",
            contactName: "Bob",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.test/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      // No "failed" actions — skipped is success-shaped from the run's POV.
      expect(updatedRun?.status).toBe("completed");

      const actions = updatedRun?.actions as Array<{
        status: string;
        payload: { skipReason?: string; day: number };
      }>;
      expect(actions).toHaveLength(3);
      // All 3 emails should be skipped (one suppression covers the whole sequence).
      for (const action of actions) {
        expect(action.status).toBe("skipped");
        expect(action.payload.skipReason).toBe("customer_email_suppressed");
      }
    });

    it("respects topic='all' master switch (skips onboarding even with 'all' row)", async () => {
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "carol@example.com",
        topic: "all",
        reason: "user_unsubscribe",
        metadata: {},
      });

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Onboarding all-topic skip",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "carol@example.com",
            contactName: "Carol",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.test/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      const actions = updatedRun?.actions as Array<{ status: string }>;
      expect(actions.every((a) => a.status === "skipped")).toBe(true);
    });

    it("does NOT skip when only an UNRELATED topic suppression exists", async () => {
      // Suppress for churn_rescue only — onboarding sends MUST still go.
      await db.insert(customerEmailSuppressions).values({
        companyId,
        contactEmail: "dave@example.com",
        topic: "churn_rescue",
        reason: "user_unsubscribe",
        metadata: {},
      });

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Onboarding ignores unrelated topic",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "dave@example.com",
            contactName: "Dave",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.test/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      const actions = updatedRun?.actions as Array<{ status: string }>;
      // None should be skipped — onboarding ≠ churn_rescue.
      expect(actions.every((a) => a.status === "completed")).toBe(true);
    });
  });
});
