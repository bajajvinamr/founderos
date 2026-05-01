import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.ts";

// Lifecycle invariant test (Tier 2):
// `budgets.getInvocationBlock` is the run-start gate consumed by both
// `claimQueuedRun` (heartbeat.ts:1247) and the wakeup-request creator
// (heartbeat.ts:2927). When it returns a non-null block, the run is
// cancelled / the wakeup is rejected and no work starts.
//
// This pins the exact threshold semantics against a real Postgres so
// SQL-level regressions (bad column names, scope_type filter drift,
// window predicate breaks) cannot ship green. Existing mock-based
// coverage in budgets-service.test.ts validates the orchestration; this
// file validates the schema binding and threshold boundary.
//
// Specifically tested:
//   1. observed >= amount blocks (exact-threshold inclusivity)
//   2. observed < amount does NOT block (no over-block on under-spend)
//   3. hardStopEnabled=false does NOT block (warn-only policies)
//   4. isActive=false does NOT block (deactivated policies are ignored)
//   5. Project-scope blocks (third hierarchy tier — only company+agent
//      have mock coverage today)
//   6. No policies at all → null (positive: must allow run)

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget-block tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("budgets.getInvocationBlock — run-start gate", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof budgetService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-budget-block-");
    db = createDb(tempDb.connectionString);
    svc = budgetService(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE cost_events, budget_policies, projects, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts?: { withProject?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = opts?.withProject ? randomUUID() : null;

    await db.insert(companies).values({
      id: companyId,
      name: "TenantA",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (projectId) {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "P1",
        status: "active",
      });
    }

    return { companyId, agentId, projectId };
  }

  async function insertSpend(
    companyId: string,
    agentId: string,
    costCents: number,
    opts?: { projectId?: string | null },
  ) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      projectId: opts?.projectId ?? null,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
      model: "claude-sonnet-4",
      costCents,
      occurredAt: new Date(),
    });
  }

  it("blocks when agent observed spend exactly equals the hard-stop amount (>= boundary)", async () => {
    const { companyId, agentId } = await seed();

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    });

    await insertSpend(companyId, agentId, 100); // exactly at limit

    const block = await svc.getInvocationBlock(companyId, agentId);

    expect(block).not.toBeNull();
    expect(block).toMatchObject({
      scopeType: "agent",
      scopeId: agentId,
      reason: expect.stringContaining("budget hard-stop"),
    });
  });

  it("does NOT block when agent observed spend is below the hard-stop amount", async () => {
    const { companyId, agentId } = await seed();

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    });

    await insertSpend(companyId, agentId, 99); // 1 cent under

    const block = await svc.getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  });

  it("does NOT block when hardStopEnabled is false even if observed exceeds amount (warn-only policy)", async () => {
    const { companyId, agentId } = await seed();

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 50,
      hardStopEnabled: false, // warn-only
      isActive: true,
    });

    await insertSpend(companyId, agentId, 1_000); // 20x over

    const block = await svc.getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  });

  it("does NOT block when policy isActive=false (deactivated policies are ignored)", async () => {
    const { companyId, agentId } = await seed();

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 50,
      hardStopEnabled: true,
      isActive: false, // off
    });

    await insertSpend(companyId, agentId, 1_000);

    const block = await svc.getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  });

  it("blocks when project-scope hard-stop is exceeded (third hierarchy tier)", async () => {
    const { companyId, agentId, projectId } = await seed({ withProject: true });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId!,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 200,
      hardStopEnabled: true,
      isActive: true,
    });

    await insertSpend(companyId, agentId, 250, { projectId });

    const block = await svc.getInvocationBlock(companyId, agentId, { projectId });

    expect(block).not.toBeNull();
    expect(block).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      reason: expect.stringContaining("Project"),
    });
  });

  it("returns null when no budget policy exists at all (positive path: work must start)", async () => {
    const { companyId, agentId, projectId } = await seed({ withProject: true });

    const block = await svc.getInvocationBlock(companyId, agentId, { projectId });
    expect(block).toBeNull();
  });
});
