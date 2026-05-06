/**
 * workflow-rate-limit.test.ts — S4.8 prerequisite #199.
 *
 * Per-tenant daily cap on workflow_run creation. Tests:
 *   1. Empty tenant — first run is allowed
 *   2. Cap honored for churn_rescue (default 50/day)
 *   3. Env override raises cap (FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE=1)
 *   4. Cross-tenant: company A's runs don't count toward company B's cap
 *   5. Cross-template: onboarding-emails runs don't count toward churn_rescue cap
 *   6. Rolling 24h window: runs older than 24h don't count
 *   7. assertWorkflowRunRateLimit throws on cap; checkWorkflowRunRateLimit doesn't
 *   8. getDailyCapForTemplate handles unknown templates with FALLBACK_CAP
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  workflowRuns,
  workflows,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertWorkflowRunRateLimit,
  checkWorkflowRunRateLimit,
  getDailyCapForTemplate,
  RateLimitExceededError,
} from "../services/workflow-rate-limit.js";

// ── Pure unit tests ─────────────────────────────────────────────────────────

describe("getDailyCapForTemplate", () => {
  beforeEach(() => {
    delete process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE;
    delete process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_UPSELL;
    delete process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_MYSTERY;
  });

  it("returns 50 for churn_rescue (default)", () => {
    expect(getDailyCapForTemplate("churn-rescue")).toBe(50);
  });

  it("returns 200 for onboarding-emails (default)", () => {
    expect(getDailyCapForTemplate("onboarding-emails")).toBe(200);
  });

  it("returns 50 for unknown template (fallback)", () => {
    expect(getDailyCapForTemplate("mystery-template")).toBe(50);
  });

  it("respects env override on known template", () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE = "100";
    expect(getDailyCapForTemplate("churn-rescue")).toBe(100);
  });

  it("respects env override on unknown template", () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_MYSTERY = "7";
    expect(getDailyCapForTemplate("mystery")).toBe(7);
  });

  it("ignores non-numeric env override and falls back", () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_UPSELL = "abc";
    expect(getDailyCapForTemplate("upsell")).toBe(100); // default upsell cap
  });

  it("ignores zero / negative env override", () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_UPSELL = "-5";
    expect(getDailyCapForTemplate("upsell")).toBe(100);
  });

  it("normalizes hyphenated template names to upper-snake env keys", () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_ACTIVATION_NUDGE = "30";
    expect(getDailyCapForTemplate("activation-nudge")).toBe(30);
  });
});

// ── Integration tests ──────────────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping workflow-rate-limit integration tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("workflow-rate-limit — DB integration", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;
  let workflowAChurnId: string;
  let workflowAOnbId: string;
  let workflowBChurnId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("wf-rate-limit");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    delete process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE;

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [companyA] = await db
      .insert(companies)
      .values({
        name: "Company A",
        instanceId: "test-instance",
        issuePrefix: `RA${suffix}`,
      })
      .returning();
    const [companyB] = await db
      .insert(companies)
      .values({
        name: "Company B",
        instanceId: "test-instance",
        issuePrefix: `RB${suffix}`,
      })
      .returning();
    companyAId = companyA.id;
    companyBId = companyB.id;

    // Workflows for the FK in workflow_runs
    const [wAC] = await db
      .insert(workflows)
      .values({
        companyId: companyAId,
        name: "A churn",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 12 * * *" },
        autonomyLevel: 4,
        status: "active",
        config: {},
      })
      .returning();
    workflowAChurnId = wAC.id;

    const [wAO] = await db
      .insert(workflows)
      .values({
        companyId: companyAId,
        name: "A onboarding",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: { source: "posthog", event: "identify" },
        autonomyLevel: 4,
        status: "active",
        config: {},
      })
      .returning();
    workflowAOnbId = wAO.id;

    const [wBC] = await db
      .insert(workflows)
      .values({
        companyId: companyBId,
        name: "B churn",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 12 * * *" },
        autonomyLevel: 4,
        status: "active",
        config: {},
      })
      .returning();
    workflowBChurnId = wBC.id;
  });

  async function seedRuns(
    workflowId: string,
    companyId: string,
    count: number,
    createdOffsetSec = 0,
  ) {
    const now = new Date();
    const rows = [];
    const seedTag = Math.random().toString(36).slice(2, 8);
    for (let i = 0; i < count; i++) {
      rows.push({
        workflowId,
        companyId,
        status: "completed" as const,
        triggeredBy: { kind: "test" },
        actions: [],
        createdAt: new Date(now.getTime() - createdOffsetSec * 1000),
        // Synthetic per-row idempotency key — workflow_runs_idempotency_unique
        // is UNIQUE NULLS NOT DISTINCT, so all-NULL bulk inserts collide.
        idempotencyKey: `seed-${seedTag}-${i}`,
      });
    }
    if (rows.length > 0) {
      await db.insert(workflowRuns).values(rows);
    }
  }

  it("allows the first run on an empty tenant", async () => {
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.current).toBe(0);
    expect(decision.cap).toBe(50);
  });

  it("blocks at the default 50/day cap for churn_rescue", async () => {
    await seedRuns(workflowAChurnId, companyAId, 50);
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.current).toBe(50);
  });

  it("env override raises the cap", async () => {
    process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE = "100";
    await seedRuns(workflowAChurnId, companyAId, 51);
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.cap).toBe(100);
    expect(decision.current).toBe(51);
  });

  it("cross-tenant: company A's runs don't count toward company B's cap", async () => {
    await seedRuns(workflowAChurnId, companyAId, 50);
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyBId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.current).toBe(0);
  });

  it("cross-template: onboarding runs don't count toward churn_rescue cap", async () => {
    await seedRuns(workflowAOnbId, companyAId, 100);
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.current).toBe(0);
  });

  it("rolling 24h window: runs older than 24h don't count", async () => {
    // Seed 50 runs from 25h ago — should NOT count.
    await seedRuns(workflowAChurnId, companyAId, 50, 25 * 60 * 60);
    const decision = await checkWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.current).toBe(0);
  });

  it("assertWorkflowRunRateLimit throws on cap exceeded", async () => {
    await seedRuns(workflowAChurnId, companyAId, 50);
    await expect(
      assertWorkflowRunRateLimit(db, companyAId, "churn-rescue"),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("assertWorkflowRunRateLimit returns decision when under cap", async () => {
    await seedRuns(workflowAChurnId, companyAId, 5);
    const decision = await assertWorkflowRunRateLimit(
      db,
      companyAId,
      "churn-rescue",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.current).toBe(5);
  });

  afterEach(() => {
    delete process.env.FOUNDEROS_WORKFLOW_DAILY_CAP_CHURN_RESCUE;
  });
});
