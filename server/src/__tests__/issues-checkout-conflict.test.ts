import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

// Trust-boundary invariant test (Tier 1):
// When two agents (or two runs of the same agent) race to check out the
// same issue, exactly one wins. The losing run must receive a 409
// conflict carrying the current state, not a partial-success
// pseudo-checkout that double-claims the issue.
//
// This is enforced by the conditional UPDATE in issues.ts:1786-1804
// with predicate executionLockCondition: the UPDATE only succeeds when
// executionRunId is null OR equals the caller's runId. Postgres'
// row-level atomicity guarantees only one of two concurrent UPDATEs
// can satisfy that predicate.
//
// We don't actually fire two concurrent UPDATEs (Postgres' atomicity is
// the contract being relied upon, not the application's job to verify).
// Instead we pin the application-side conflict-detection branch:
// given a row already locked by run A, a run-B checkout must throw
// 409 with the current state attached. If a future refactor weakens
// the executionLockCondition predicate or the post-conflict
// metadata read, this test goes red.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout-conflict tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.checkout — conflict detection", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-checkout-conflict-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE issues, heartbeat_runs, agents, companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TenantA",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "T-1",
      title: "Build the thing",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  async function startRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "test",
      startedAt: new Date(),
    });
    return runId;
  }

  it("second checkout with a different runId throws 409 with current state attached", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runA = await startRun(companyId, agentId);
    const runB = await startRun(companyId, agentId);

    // First checkout (run A) succeeds and stamps executionRunId = runA.
    const first = await svc.checkout(issueId, agentId, ["todo", "in_progress", "blocked", "backlog"], runA);
    expect(first?.id).toBe(issueId);
    expect(first?.status).toBe("in_progress");
    expect(first?.executionRunId).toBe(runA);

    // Second checkout from a different run must lose.
    let conflictErr: unknown;
    try {
      await svc.checkout(issueId, agentId, ["todo", "in_progress", "blocked", "backlog"], runB);
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeDefined();
    expect((conflictErr as { status?: number }).status).toBe(409);
    expect((conflictErr as { details?: { executionRunId?: string } }).details?.executionRunId).toBe(runA);
  });

  it("same-run repeated checkout is idempotent (returns issue, no conflict)", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runA = await startRun(companyId, agentId);

    const first = await svc.checkout(issueId, agentId, ["todo", "in_progress"], runA);
    const second = await svc.checkout(issueId, agentId, ["todo", "in_progress"], runA);

    expect(first?.id).toBe(issueId);
    expect(second?.id).toBe(issueId);
    expect(second?.executionRunId).toBe(runA);
  });

  it("checkout with no runId fails when executionRunId is already locked by another run", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runA = await startRun(companyId, agentId);

    await svc.checkout(issueId, agentId, ["todo"], runA);

    let conflictErr: unknown;
    try {
      await svc.checkout(issueId, agentId, ["in_progress", "todo"], null);
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeDefined();
    expect((conflictErr as { status?: number }).status).toBe(409);
  });

  it("conflict-state read includes the winning run's id and status (founder-debuggable)", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runA = await startRun(companyId, agentId);
    const runB = await startRun(companyId, agentId);

    await svc.checkout(issueId, agentId, ["todo"], runA);

    let err: unknown;
    try {
      await svc.checkout(issueId, agentId, ["todo", "in_progress"], runB);
    } catch (e) {
      err = e;
    }

    const details = (err as { details?: { executionRunId?: string; checkoutRunId?: string; status?: string; assigneeAgentId?: string } }).details;
    expect(details).toMatchObject({
      executionRunId: runA,
      checkoutRunId: runA,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
  });
});
