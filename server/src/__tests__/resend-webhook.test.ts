/**
 * resend-webhook.test.ts — integration tests for the Resend webhook receiver
 * (W0.2c, council 2026-05-05).
 *
 * Coverage map:
 *   A. Signature verification
 *      A1. Missing svix headers → 401
 *      A2. Bad signature (wrong secret) → 401
 *      A3. Stale timestamp (> 5min) → 401
 *      A4. Valid signature → handler runs
 *
 *   B. Action lifecycle updates
 *      B1. email.delivered → action.payload.delivered=true; status stays completed
 *      B2. email.bounced → action.status=failed, run.status=failed, error stored
 *      B3. email.complained → payload flag set, status unchanged
 *      B4. Unknown event type → 200 untracked
 *      B5. No workflow_run_id tag → 200 ignored
 *      B6. Workflow run not found → 200, no DB mutation
 *      B7. providerMessageId not in any action → 200, no DB mutation
 *
 *   C. Configuration
 *      C1. RESEND_WEBHOOK_SECRET unset → 503 "webhook not configured"
 *
 * Notes on signature production: tests build the Svix header values exactly
 * as Resend does — secret base64 → HMAC-SHA256 over `${id}.${ts}.${rawBody}`
 * → base64 encode → prefix with `v1,`.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, workflows, workflowRuns } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resendWebhookRoutes } from "../routes/resend-webhook.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping resend-webhook tests: ${support.reason ?? "unsupported"}`);
}

// ── Svix signature builder for tests ────────────────────────────────────────

const TEST_SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXJlc2VuZC13MGMtMjAyNi0wNS0wNg=="; // "test-secret-for-resend-w0c-2026-05-06"

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

// ── Test suite ──────────────────────────────────────────────────────────────

describeEmbeddedPostgres("Resend webhook (W0.2c)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let runId!: string;
  let workflowId!: string;
  const providerMessageId = "resend-msg-test-w0c-001";

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-resend-webhook-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Webhook Test Co", issuePrefix: "WHK" })
      .returning({ id: companies.id });
    companyId = company!.id;

    const [w] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Onboarding for webhook",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: {},
        autonomyLevel: 4,
        status: "active",
        config: { contactEmail: "user@example.com" },
      })
      .returning();
    workflowId = w!.id;

    // Seed a run with a single send_email action carrying our test providerMessageId.
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
              recipientEmail: "user@example.com",
              providerMessageId,
              transportMode: "resend",
            },
          },
        ],
      })
      .returning({ id: workflowRuns.id });
    runId = run!.id;

    process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  });

  // Helper to POST a Resend event with a valid Svix signature.
  async function postEvent(app: express.Express, payload: object, opts: { tsOffsetMs?: number; corruptSig?: boolean } = {}) {
    const body = JSON.stringify(payload);
    const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
    const ts = Math.floor((Date.now() + (opts.tsOffsetMs ?? 0)) / 1000);
    const sig = opts.corruptSig
      ? "v1,corruptsignaturevaluethatdoesnotmatch=="
      : signSvix(body, TEST_SECRET, id, ts);
    return request(app)
      .post("/api/webhooks/resend")
      .set("svix-id", id)
      .set("svix-timestamp", String(ts))
      .set("svix-signature", sig)
      .set("content-type", "application/json")
      .send(body);
  }

  // ── A. Signature verification ──────────────────────────────────────────────

  describe("A. Signature verification", () => {
    it("A1. Missing svix headers → 401", async () => {
      const app = buildApp(db);
      const res = await request(app)
        .post("/api/webhooks/resend")
        .set("content-type", "application/json")
        .send({ type: "email.delivered", data: {} });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe("missing-headers");
    });

    it("A2. Bad signature (corrupt) → 401", async () => {
      const app = buildApp(db);
      const res = await postEvent(
        app,
        {
          type: "email.delivered",
          data: { email_id: providerMessageId, tags: [{ name: "workflow_run_id", value: runId }] },
        },
        { corruptSig: true },
      );
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe("signature-mismatch");
    });

    it("A3. Stale timestamp (> 5min) → 401", async () => {
      const app = buildApp(db);
      const res = await postEvent(
        app,
        {
          type: "email.delivered",
          data: { email_id: providerMessageId, tags: [{ name: "workflow_run_id", value: runId }] },
        },
        { tsOffsetMs: -10 * 60 * 1000 }, // 10min ago
      );
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe("stale-timestamp");
    });

    it("A4. Valid signature → handler runs", async () => {
      const app = buildApp(db);
      const res = await postEvent(app, {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: providerMessageId,
          tags: [{ name: "workflow_run_id", value: runId }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── B. Action lifecycle updates ────────────────────────────────────────────

  describe("B. Action lifecycle updates", () => {
    it("B1. email.delivered → action.payload.delivered=true; status stays completed", async () => {
      const app = buildApp(db);
      const at = new Date().toISOString();
      const res = await postEvent(app, {
        type: "email.delivered",
        created_at: at,
        data: {
          email_id: providerMessageId,
          tags: [{ name: "workflow_run_id", value: runId }],
        },
      });
      expect(res.status).toBe(200);

      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const action = run!.actions![0]! as { status: string; payload: Record<string, unknown> };
      expect(action.status).toBe("completed");
      expect(action.payload.delivered).toBe(true);
      expect(action.payload.deliveredAt).toBe(at);
      expect(run!.status).toBe("completed"); // run-level unchanged
    });

    it("B2. email.bounced → action failed + run failed + reason stored", async () => {
      const app = buildApp(db);
      const at = new Date().toISOString();
      const res = await postEvent(app, {
        type: "email.bounced",
        created_at: at,
        data: {
          email_id: providerMessageId,
          tags: [{ name: "workflow_run_id", value: runId }],
          bounce: { message: "mailbox does not exist", subType: "Permanent" },
        },
      });
      expect(res.status).toBe(200);

      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const action = run!.actions![0]! as { status: string; error?: string; payload: Record<string, unknown> };
      expect(action.status).toBe("failed");
      expect(action.error).toBe("mailbox does not exist");
      expect(action.payload.bounced).toBe(true);
      expect(action.payload.bouncedAt).toBe(at);
      expect(action.payload.bounceReason).toBe("mailbox does not exist");
      expect(run!.status).toBe("failed"); // run-level reflects bounce
      expect(run!.completedAt).not.toBeNull();
    });

    it("B3. email.complained → payload flag set, status unchanged", async () => {
      const app = buildApp(db);
      const at = new Date().toISOString();
      const res = await postEvent(app, {
        type: "email.complained",
        created_at: at,
        data: {
          email_id: providerMessageId,
          tags: [{ name: "workflow_run_id", value: runId }],
        },
      });
      expect(res.status).toBe(200);

      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const action = run!.actions![0]! as { status: string; payload: Record<string, unknown> };
      expect(action.status).toBe("completed"); // unchanged
      expect(action.payload.complained).toBe(true);
      expect(action.payload.complainedAt).toBe(at);
      expect(run!.status).toBe("completed");
    });

    it("B4. Unknown event type → 200 untracked", async () => {
      const app = buildApp(db);
      const res = await postEvent(app, {
        type: "email.opened",
        data: {
          email_id: providerMessageId,
          tags: [{ name: "workflow_run_id", value: runId }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.untracked).toBe("email.opened");
    });

    it("B5. No workflow_run_id tag → 200 ignored", async () => {
      const app = buildApp(db);
      const res = await postEvent(app, {
        type: "email.delivered",
        data: { email_id: "some-other-msg", tags: [] },
      });
      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe(true);
    });

    it("B6. Workflow run not found → 200, no DB mutation", async () => {
      const app = buildApp(db);
      const res = await postEvent(app, {
        type: "email.delivered",
        data: {
          email_id: providerMessageId,
          tags: [
            { name: "workflow_run_id", value: "00000000-0000-0000-0000-000000000000" },
          ],
        },
      });
      expect(res.status).toBe(200);

      // Existing run untouched.
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const action = run!.actions![0]! as { payload: Record<string, unknown> };
      expect(action.payload.delivered).toBeUndefined();
    });

    it("B7. providerMessageId not in any action → 200, no DB mutation", async () => {
      const app = buildApp(db);
      const res = await postEvent(app, {
        type: "email.delivered",
        data: {
          email_id: "msg-not-in-any-action",
          tags: [{ name: "workflow_run_id", value: runId }],
        },
      });
      expect(res.status).toBe(200);

      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      const action = run!.actions![0]! as { payload: Record<string, unknown> };
      expect(action.payload.delivered).toBeUndefined();
    });
  });

  // ── C. Configuration ──────────────────────────────────────────────────────

  describe("C. Configuration", () => {
    it("C1. RESEND_WEBHOOK_SECRET unset → 503 webhook not configured", async () => {
      delete process.env.RESEND_WEBHOOK_SECRET;
      const app = buildApp(db);
      const res = await request(app)
        .post("/api/webhooks/resend")
        .set("svix-id", "msg_test")
        .set("svix-timestamp", String(Math.floor(Date.now() / 1000)))
        .set("svix-signature", "v1,placeholder")
        .set("content-type", "application/json")
        .send({ type: "email.delivered", data: {} });
      expect(res.status).toBe(503);
      // restore for downstream tests
      process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
    });
  });
});
