import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Cascade invariant test (Tier 2):
// When a COMPANY is paused, every agent under that company is implicitly
// blocked from starting work — even agents whose own status is "active".
// The cascade lives at budgets.ts:743 inside getInvocationBlock, which
// the wakeup() path consults at heartbeat.ts:2991. Without this gate, a
// founder pausing the company at the org level (e.g., spend hard-stop
// reached, instance-level enforcement) would still see new wakeups
// scheduled by issue assignments / approvals / comments / plugin paths
// because every active agent would individually pass its own status
// check.
//
// Companion to paused-agent-blocks-heartbeat.test.ts which pins the
// agent-level pause; this pins the org-level cascade. Together the two
// tests cover both legs of the budget-driven pause hierarchy promised
// in `.qa/dream-state-scorecard.md` ("Pause cascades — paused company
// halts all its agents").

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres paused-company cascade tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat — paused company cascades to its agents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-paused-company-cascade-");
    db = createDb(tempDb.connectionString);
    svc = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // Order matters — agent_wakeup_requests has FKs to agents (which has
    // FK to companies), and heartbeat_runs has FKs to both. The cascade
    // path writes a "budget.blocked" audit row to agent_wakeup_requests
    // before throwing, so we MUST clear it before agents.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedActiveAgentUnderCompany(
    companyStatus: "active" | "paused",
    pauseReason: "budget" | null = null,
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TenantA",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: companyStatus,
      pauseReason,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      // The agent itself is fully active — the cascade gate is what
      // must catch the wakeup, not the agent's own pause check.
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("wakeup is blocked when company.status=paused (active agent under paused company)", async () => {
    const { companyId, agentId } = await seedActiveAgentUnderCompany("paused");

    let err: unknown;
    try {
      await svc.wakeup(agentId, { source: "assignment", triggerDetail: "test" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { status?: number }).status).toBe(409);
    // The cascade reason carries scopeType="company" + the company's id,
    // so the UI / log can attribute the block to the org, not the agent.
    expect((err as { details?: { scopeType?: string } }).details?.scopeType).toBe("company");
    expect((err as { details?: { scopeId?: string } }).details?.scopeId).toBe(companyId);
  });

  it("wakeup error message references the budget hard-stop when pauseReason='budget'", async () => {
    const { agentId } = await seedActiveAgentUnderCompany("paused", "budget");

    let err: unknown;
    try {
      await svc.wakeup(agentId, { source: "assignment", triggerDetail: "test" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { status?: number }).status).toBe(409);
    // Message wording lives in budgets.ts:750 — pinning the user-visible
    // copy here so a refactor of that branch can't silently change what
    // founders see in the dashboard / approval UI.
    expect((err as Error).message).toMatch(/budget hard-stop/i);
  });

  // Negative case ("active company does not trigger the cascade") is
  // intentionally NOT tested here. Driving wakeup all the way through
  // for an active company creates heartbeat_run + heartbeat_run_event
  // rows that drag a deeper FK cleanup chain into this test, and the
  // direct getInvocationBlock-returns-null coverage already exists in
  // `budget-blocks-run-start.test.ts`. This file's job is the cascade
  // gate's _positive_ pin only.
});
