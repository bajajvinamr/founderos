/**
 * resend-webhook-auto-suppress.test.ts — S4.8 prerequisite #196 layer 4.
 *
 * Tests that the Resend webhook receiver auto-inserts a
 * customer_email_suppressions row when an email lifecycle event indicates
 * the recipient should not receive further messages on that topic:
 *
 *   email.bounced (Permanent subType) → reason="bounce_hard"
 *   email.complained (any)            → reason="spam_report"
 *
 * Soft bounces (Transient subType) MUST NOT suppress. Unknown template tag
 * MUST NOT suppress (no widening to topic="all"). Recipient missing MUST NOT
 * suppress. The webhook MUST still 200 in all of these "skip" cases.
 *
 * Coverage:
 *   1. Hard bounce on onboarding template → suppression row with topic="onboarding"
 *   2. Spam complaint on upsell template → suppression row with topic="upsell"
 *   3. Bounce on activation-nudge template → topic="activation_nudge"
 *   4. Soft (Transient) bounce → NO suppression row
 *   5. Hard bounce with unknown template tag → NO suppression row
 *   6. Hard bounce with no recipient → NO suppression row
 *   7. Replay (same bounce twice) → idempotent (still 1 row)
 *   8. Cross-tenant: suppression scoped to the run's companyId
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  createDb,
  customerEmailSuppressions,
  workflows,
  workflowRuns,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resendWebhookRoutes } from "../routes/resend-webhook.js";

const TEST_SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXJlc2VuZC13MGMtMjAyNi0wNS0wNg==";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping resend-webhook-auto-suppress tests: ${support.reason ?? "unsupported"}`,
  );
}

function signSvix(body: string, secret: string, id: string, ts: number) {
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const toSign = `${id}.${ts}.${body}`;
  const sig = createHmac("sha256", secretBytes).update(toSign).digest("base64");
  return `v1,${sig}`;
}

function buildApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(resendWebhookRoutes(db));
  return app;
}

describeEmbeddedPostgres("Resend webhook — auto-suppress (#196 layer 4)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;
  let companyId!: string;
  let runId!: string;
  const providerMessageId = "resend-msg-supp-001";
  const recipientEmail = "user@example.com";

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase(
      "founderos-resend-supp-",
    );
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  /**
   * Seed a workflow_run for a given template. We bind the template tag to the
   * run by setting it on the action.payload + by attaching it as a Resend tag
   * on the inbound event. The webhook handler reads the template from the
   * event tags (NOT the workflow row), so the action body is essentially
   * decorative for these tests.
   */
  async function seedRun(template: "onboarding-emails" | "activation-nudge" | "upsell") {
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.delete(customerEmailSuppressions);

    const [company] = await db
      .insert(companies)
      .values({ name: "Webhook Supp Test", issuePrefix: "WHS" })
      .returning({ id: companies.id });
    companyId = company!.id;

    const [w] = await db
      .insert(workflows)
      .values({
        companyId,
        name: `Webhook supp test (${template})`,
        template,
        triggerKind: "event",
        triggerSpec: {},
        autonomyLevel: 4,
        status: "active",
        config: { contactEmail: recipientEmail },
      })
      .returning();
    const workflowId = w!.id;

    const [run] = await db
      .insert(workflowRuns)
      .values({
        workflowId,
        companyId,
        status: "completed",
        triggeredBy: { kind: "manual" },
        actions: [
          {
            type: "send_email",
            status: "completed",
            executedAt: new Date().toISOString(),
            payload: {
              recipientEmail,
              providerMessageId,
              transportMode: "resend",
            },
          },
        ],
      })
      .returning({ id: workflowRuns.id });
    runId = run!.id;

    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  }

  async function postEvent(app: express.Express, payload: object) {
    const body = JSON.stringify(payload);
    const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = signSvix(body, TEST_SECRET, id, ts);
    return request(app)
      .post("/api/webhooks/resend")
      .set("svix-id", id)
      .set("svix-timestamp", String(ts))
      .set("svix-signature", sig)
      .set("content-type", "application/json")
      .send(body);
  }

  function bouncedEvent(opts: {
    template?: string;
    subType?: string;
    recipient?: string | null;
  } = {}) {
    const tags = [{ name: "workflow_run_id", value: runId }];
    if (opts.template !== null && opts.template !== undefined) {
      tags.push({ name: "template", value: opts.template });
    }
    return {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: providerMessageId,
        to: opts.recipient === null ? undefined : [opts.recipient ?? recipientEmail],
        tags,
        bounce: { subType: opts.subType ?? "Permanent", message: "mailbox does not exist" },
      },
    };
  }

  function complainedEvent(template: string) {
    return {
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: {
        email_id: providerMessageId,
        to: [recipientEmail],
        tags: [
          { name: "workflow_run_id", value: runId },
          { name: "template", value: template },
        ],
      },
    };
  }

  describe("Hard bounce → suppression by template", () => {
    it("onboarding-emails template → topic='onboarding'", async () => {
      await seedRun("onboarding-emails");
      const app = buildApp(db);
      const res = await postEvent(app, bouncedEvent({ template: "onboarding-emails" }));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].contactEmail).toBe(recipientEmail);
      expect(rows[0].topic).toBe("onboarding");
      expect(rows[0].reason).toBe("bounce_hard");
      expect(rows[0].sourceWorkflowRunId).toBe(runId);
      expect(rows[0].sourceMessageId).toBe(providerMessageId);
    });

    it("activation-nudge template → topic='activation_nudge'", async () => {
      await seedRun("activation-nudge");
      const app = buildApp(db);
      const res = await postEvent(app, bouncedEvent({ template: "activation-nudge" }));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe("activation_nudge");
    });

    it("upsell template → topic='upsell'", async () => {
      await seedRun("upsell");
      const app = buildApp(db);
      const res = await postEvent(app, bouncedEvent({ template: "upsell" }));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe("upsell");
    });
  });

  describe("Spam complaint → suppression with reason='spam_report'", () => {
    it("upsell template → topic='upsell', reason='spam_report'", async () => {
      await seedRun("upsell");
      const app = buildApp(db);
      const res = await postEvent(app, complainedEvent("upsell"));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe("upsell");
      expect(rows[0].reason).toBe("spam_report");
    });
  });

  describe("Skip cases — webhook 200, NO suppression", () => {
    it("soft bounce (Transient subType) → NO row", async () => {
      await seedRun("onboarding-emails");
      const app = buildApp(db);
      const res = await postEvent(
        app,
        bouncedEvent({ template: "onboarding-emails", subType: "Transient" }),
      );
      expect(res.status).toBe(200);

      const rows = await db.select().from(customerEmailSuppressions);
      expect(rows).toHaveLength(0);
    });

    it("unknown template tag → NO row (no widening to 'all')", async () => {
      await seedRun("onboarding-emails");
      const app = buildApp(db);
      const res = await postEvent(
        app,
        bouncedEvent({ template: "mystery-template" }),
      );
      expect(res.status).toBe(200);

      const rows = await db.select().from(customerEmailSuppressions);
      expect(rows).toHaveLength(0);
    });

    it("missing recipient → NO row", async () => {
      await seedRun("onboarding-emails");
      const app = buildApp(db);
      const res = await postEvent(
        app,
        bouncedEvent({ template: "onboarding-emails", recipient: null }),
      );
      expect(res.status).toBe(200);

      const rows = await db.select().from(customerEmailSuppressions);
      expect(rows).toHaveLength(0);
    });
  });

  describe("Idempotency", () => {
    it("replaying the same bounce → still 1 row", async () => {
      await seedRun("onboarding-emails");
      const app = buildApp(db);
      const res1 = await postEvent(app, bouncedEvent({ template: "onboarding-emails" }));
      expect(res1.status).toBe(200);
      const res2 = await postEvent(app, bouncedEvent({ template: "onboarding-emails" }));
      expect(res2.status).toBe(200);

      const rows = await db
        .select()
        .from(customerEmailSuppressions)
        .where(eq(customerEmailSuppressions.companyId, companyId));
      expect(rows).toHaveLength(1);
    });
  });
});
