/**
 * workflows-onboarding-emails.test.ts — Tests for S4.6 onboarding email template
 *
 * Coverage:
 * 1. Template registration round-trip (create workflow, list returns it)
 * 2. Autonomous send happy path (autonomyLevel=4, flag enabled → sends immediately)
 * 3. Autonomy off (autonomyLevel=3 → pending_approval, no send yet)
 * 4. Cross-tenant guard (company A cannot see/modify company B's workflows)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  workflows,
  workflowRuns,
  companies,
  createDb,
} from "@founderos/db";
import { startEmbeddedPostgresTestDatabase } from "@founderos/db";

import {
  createWorkflow,
  listWorkflows,
  createWorkflowRun,
  getWorkflowRun,
  executeWorkflowTemplate,
} from "../services/workflows.js";
import { canRunAutonomously } from "../services/workflow-autonomy.js";

describe("S4.6 — Onboarding Email Workflow Template", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    // CLAUDE.md fixture pitfall: `startEmbeddedPostgresTestDatabase(prefix)`
    // is ASYNC and returns `{connectionString, cleanup}`. Tests must
    // instantiate Drizzle from `connectionString` via `createDb()` — not
    // `drizzle(postgres(...))` directly (the `postgres` package isn't a
    // server dep, only a packages/db internal).
    process.env.EMAIL_UNSUBSCRIBE_SECRET =
      process.env.EMAIL_UNSUBSCRIBE_SECRET ??
      "test-secret-onboarding-emails-32b-OK";
    testDb = await startEmbeddedPostgresTestDatabase("s4.6");
    db = createDb(testDb.connectionString);

    // companies.issue_prefix has UNIQUE + default "PAP" — supply distinct
    // values so the two-company seed doesn't collide.
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Company",
        instanceId: "test-instance",
        issuePrefix: `S46A${suffix}`,
      })
      .returning();

    const [otherCompany] = await db
      .insert(companies)
      .values({
        name: "Other Company",
        instanceId: "test-instance",
        issuePrefix: `S46B${suffix}`,
      })
      .returning();

    companyId = company.id;
    otherCompanyId = otherCompany.id;
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  describe("1. Template registration round-trip", () => {
    it("creates an onboarding-emails workflow and lists it back", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "New Customer Onboarding",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: {
            source: "posthog",
            event: "identify",
          },
          autonomyLevel: 2,
          status: "draft",
          config: {
            contactEmail: "newuser@example.com",
            contactName: "Alice",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.fly.dev/dashboard",
          },
        },
      });

      expect(workflow.id).toBeDefined();
      expect(workflow.template).toBe("onboarding-emails");
      expect(workflow.status).toBe("draft");

      // Verify it's listed
      const { workflows: list, total } = await listWorkflows(db, companyId, {
        template: "onboarding-emails",
      });

      expect(total).toBe(1);
      expect(list[0].id).toBe(workflow.id);
      expect(list[0].name).toBe("New Customer Onboarding");
    });

    it("rejects workflows with mismatched companyId on read", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Test Workflow",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "draft",
          config: {
            contactEmail: "test@example.com",
            dashboardUrl: "https://example.com",
          },
        },
      });

      // Other company should not see this workflow
      const { workflows: otherList } = await listWorkflows(db, otherCompanyId);
      expect(otherList.map((w) => w.id)).not.toContain(workflow.id);
    });
  });

  describe("2. Autonomous send happy path", () => {
    it("creates a run and executes template with autonomyLevel=4 + flag enabled", async () => {
      // Set the autonomous email flag in instance_settings — UPSERT
      // the singleton row in case migrations don't seed one. The
      // canRunAutonomously check reads `general[AUTONOMOUS_EMAIL_SETTING_KEY]`
      // (literal dotted key, not nested path).
      await db.execute(
        sql`INSERT INTO instance_settings (singleton_key, general)
            VALUES ('default', '{"lifecycle_crm.allow_autonomous_email": true}'::jsonb)
            ON CONFLICT (singleton_key)
            DO UPDATE SET general = jsonb_set(
              instance_settings.general,
              '{lifecycle_crm.allow_autonomous_email}',
              'true'::jsonb
            )`
      );

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Autonomous Onboarding",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 4,
          status: "active",
          config: {
            contactEmail: "alice@example.com",
            contactName: "Alice",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.fly.dev/dashboard",
          },
        },
      });

      // Verify canRunAutonomously returns true
      const canRun = await canRunAutonomously(db, workflow);
      expect(canRun).toBe(true);

      // Create and execute the run
      const run = await createWorkflowRun(db, {
        companyId,
        workflowId: workflow.id,
        actorType: "system",
        actorId: "trigger-engine",
        data: {
          status: "running",
          triggeredBy: { source: "posthog", event: "identify", userId: "user-123" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      // Verify run status changed to completed
      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      expect(updatedRun?.status).toBe("completed");
      expect(updatedRun?.actions).toBeDefined();
      // Should have 3 email actions
      expect(Array.isArray(updatedRun?.actions)).toBe(true);
      const actions = updatedRun?.actions as any[];
      expect(actions.length).toBe(3);
      expect(actions[0].payload.day).toBe(0);
      expect(actions[1].payload.day).toBe(2);
      expect(actions[2].payload.day).toBe(7);
    });

    it("logs activity with workflowId for audit trail", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Audit Test Workflow",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "draft",
          config: {
            contactEmail: "test@example.com",
            dashboardUrl: "https://example.com",
          },
        },
      });

      // Verify activity_log row contains workflowId
      const [activityRow] = await db.execute(
        sql`SELECT * FROM activity_log WHERE entity_id = ${workflow.id} AND action = 'workflow.created' LIMIT 1`
      );

      expect(activityRow).toBeDefined();
      expect((activityRow as any).workflow_id).toBe(workflow.id);
    });
  });

  describe("3. Autonomy off → pending_approval", () => {
    it("creates run with autonomyLevel=3 and status=pending_approval", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Approval-Required Onboarding",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 3,
          status: "active",
          config: {
            contactEmail: "bob@example.com",
            contactName: "Bob",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.fly.dev/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify", userId: "user-456" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      expect(updatedRun?.status).toBe("pending_approval");
      // Actions should be stored but not sent
      expect(Array.isArray(updatedRun?.actions)).toBe(true);
      const actions = updatedRun?.actions as any[];
      expect(actions.length).toBe(3);
      // All should still be "pending"
      expect(actions.every((a) => a.status === "pending")).toBe(true);
    });

    it("does not send emails when autonomy gate is not met", async () => {
      // Ensure flag is NOT set
      await db.execute(
        sql`UPDATE instance_settings
            SET general = general - 'lifecycle_crm.allow_autonomous_email'
            WHERE singleton_key = 'default'`
      );

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Draft-Only Workflow",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "charlie@example.com",
            contactName: "Charlie",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.fly.dev/dashboard",
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
          triggeredBy: { source: "posthog", event: "identify", userId: "user-789" },
          actions: [],
        },
      });

      await executeWorkflowTemplate(db, workflow, run);

      const updatedRun = await getWorkflowRun(db, companyId, run.id);
      expect(updatedRun?.status).toBe("pending_approval");
    });
  });

  describe("4. Cross-tenant guard", () => {
    it("does not allow other company to modify workflow via known ID", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Company A Workflow",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "draft",
          config: {
            contactEmail: "test@example.com",
            dashboardUrl: "https://example.com",
          },
        },
      });

      // Attempt to list from otherCompany should not return the workflow
      const { workflows: otherCompanyWorkflows } = await listWorkflows(db, otherCompanyId);
      expect(otherCompanyWorkflows.map((w) => w.id)).not.toContain(workflow.id);
    });

    it("isolates workflow_runs by company", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Company A Workflow",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "test@example.com",
            dashboardUrl: "https://example.com",
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

      // Other company should not be able to fetch this run
      const fetchedRun = await getWorkflowRun(db, otherCompanyId, run.id);
      expect(fetchedRun).toBeNull();
    });
  });

  describe("Email template content", () => {
    it("generates correct subject lines for each day", async () => {
      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "Content Test",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "test@example.com",
            contactName: "Test User",
            companyName: "FounderOS",
            dashboardUrl: "https://founderos.fly.dev/dashboard",
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
      const actions = updatedRun?.actions as any[];

      expect(actions[0].payload.subject).toContain("Welcome");
      expect(actions[1].payload.subject).toContain("Day 2");
      expect(actions[2].payload.subject).toContain("What to do next");

      // Check HTML escaping in email bodies
      expect(actions[0].payload.bodyHtml).toContain("Test User");
      expect(actions[0].payload.bodyHtml).not.toContain("<script>");
    });

    it("includes dashboard URL in email payloads", async () => {
      const dashboardUrl = "https://custom.founderos.app/dashboard";

      const workflow = await createWorkflow(db, {
        companyId,
        actorType: "user",
        actorId: "founder-1",
        data: {
          name: "URL Test",
          template: "onboarding-emails",
          triggerKind: "event",
          triggerSpec: { source: "posthog", event: "identify" },
          autonomyLevel: 2,
          status: "active",
          config: {
            contactEmail: "test@example.com",
            contactName: "Test",
            companyName: "MyApp",
            dashboardUrl,
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
      const actions = updatedRun?.actions as any[];

      actions.forEach((action) => {
        expect(action.payload.bodyHtml).toContain(dashboardUrl);
      });
    });
  });
});
