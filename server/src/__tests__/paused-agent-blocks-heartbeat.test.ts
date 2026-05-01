import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Lifecycle invariant test (Tier 2):
// A paused (or terminated, or pending_approval) agent CANNOT enqueue a
// new wakeup and its queued runs CANNOT transition to running. The
// guards live at heartbeat.ts:2939-2944 (wakeup throw) and
// heartbeat.ts:1547-1549 (resumeQueuedRuns early-skip via
// startNextQueuedRunForAgent), with a defensive recheck at
// heartbeat.ts:1241-1244 inside claimQueuedRun for the pause-mid-batch
// race.
//
// This pins the post-pause "no work starts" promise. Without these
// guards a paused agent's queued workload would silently resume the
// moment a worker tick fires.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres paused-agent tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat — paused agent cannot start work", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-paused-agent-");
    db = createDb(tempDb.connectionString);
    svc = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status: "active" | "paused" | "terminated" | "pending_approval") {
    const companyId = randomUUID();
    const agentId = randomUUID();

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
      status,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("wakeup throws conflict when agent.status=paused", async () => {
    const { agentId } = await seedAgent("paused");

    let err: unknown;
    try {
      await svc.wakeup(agentId, { source: "assignment", triggerDetail: "test" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { details?: { status?: string } }).details?.status).toBe("paused");
  });

  it("wakeup throws conflict when agent.status=terminated", async () => {
    const { agentId } = await seedAgent("terminated");

    let err: unknown;
    try {
      await svc.wakeup(agentId, { source: "assignment", triggerDetail: "test" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { details?: { status?: string } }).details?.status).toBe("terminated");
  });

  it("wakeup throws conflict when agent.status=pending_approval", async () => {
    const { agentId } = await seedAgent("pending_approval");

    let err: unknown;
    try {
      await svc.wakeup(agentId, { source: "assignment", triggerDetail: "test" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { details?: { status?: string } }).details?.status).toBe("pending_approval");
  });

  it("resumeQueuedRuns leaves queued runs alone for a paused agent (does NOT promote to running)", async () => {
    const { companyId, agentId } = await seedAgent("paused");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
    });

    await svc.resumeQueuedRuns();

    const after = await svc.getRun(runId);
    // The status must NOT be "running". Acceptable: still "queued"
    // (early-skip in startNextQueuedRunForAgent) or "cancelled" (if a
    // future change tightens the guard to actively cancel paused-agent
    // runs at resume time). The invariant being pinned is "no work
    // starts" — i.e. running must never happen.
    expect(after?.status).not.toBe("running");
  });

  it("tickTimers skips paused agents entirely (no enqueued runs)", async () => {
    // Seed three agents: one paused, one terminated, one pending_approval.
    // Each has heartbeat policy that *would* schedule a run if eligible.
    const states: Array<"paused" | "terminated" | "pending_approval"> = [
      "paused",
      "terminated",
      "pending_approval",
    ];
    const seededIds: string[] = [];
    for (const status of states) {
      const { agentId } = await seedAgent(status);
      // Backdate lastHeartbeatAt so tickTimers would otherwise fire.
      await db
        .update(agents)
        .set({
          lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
        })
        .where(eq(agents.id, agentId));
      seededIds.push(agentId);
    }

    const result = await svc.tickTimers();

    // No agents should have been ticked (all three are non-invokable).
    expect(result.enqueued ?? 0).toBe(0);

    // Confirm: no heartbeat runs were created for any of these agents.
    for (const agentId of seededIds) {
      const runs = await svc.list(/* companyId not strict here */ "00000000-0000-4000-8000-000000000000", agentId, 5);
      // List is filtered by companyId, but since we use a non-matching
      // sentinel, this returns []. The actual proof is the runtime row
      // count below.
      expect(runs).toEqual([]);
    }
    const runCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns);
    expect(runCount.length).toBe(0);
  });
});
