/**
 * BYO-103 — byo_runner adapter tests.
 *
 * Verifies the cloud-side adapter:
 *   1. Refuses to run when FOUNDEROS_BYO_RUNNER_ENABLED is unset.
 *   2. Materializes a runner_jobs row from heartbeat input.
 *   3. Polls until terminal — completes when the row flips to 'completed'.
 *   4. Returns runner_failed errorCode when the row flips to 'failed'.
 *   5. Times out cleanly when the runner never picks up the job, marking
 *      the row 'failed' so a late-claiming runner gets a clear 409.
 *
 * Real embedded Postgres so the FK + status enum constraints are exercised
 * end-to-end. Polling tests use a short timeoutSec to keep wall time low.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  runnerJobs,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createByoRunnerAdapter } from "../adapters/byo-runner/index.js";
import type { AdapterExecutionContext } from "@founderos/adapter-utils";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping byo_runner adapter tests: ${support.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("createByoRunnerAdapter — BYO-103", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let savedFlag: string | undefined;

  let prefixCounter = 0;
  async function makeFixture(name: string) {
    prefixCounter += 1;
    const issuePrefix = `BR${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Test Sarah",
        role: "ceo",
        adapterType: "byo_runner",
        adapterConfig: {},
        status: "idle",
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();
    return { company, agent, run };
  }

  function makeCtx(args: {
    runId: string;
    companyId: string;
    agentId: string;
    timeoutSec: number;
    promptTemplate?: string;
  }): AdapterExecutionContext {
    const logs: Array<{ stream: string; chunk: string }> = [];
    return {
      runId: args.runId,
      agent: {
        id: args.agentId,
        name: "Test Sarah",
        companyId: args.companyId,
      } as AdapterExecutionContext["agent"],
      runtime: {} as AdapterExecutionContext["runtime"],
      config: {
        timeoutSec: args.timeoutSec,
        promptTemplate: args.promptTemplate ?? "You are agent {{agent.id}}.",
      },
      context: {},
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    };
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-byo-adapter-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(() => {
    savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
  });

  it("refuses to enqueue when feature flag is off", async () => {
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    const { company, agent, run } = await makeFixture("Flag Off Co");
    const adapter = createByoRunnerAdapter(db);

    const result = await adapter.execute(
      makeCtx({ runId: run.id, companyId: company.id, agentId: agent.id, timeoutSec: 1 }),
    );

    expect(result.errorCode).toBe("byo_runner_disabled");
    const queued = await db.select().from(runnerJobs).where(eq(runnerJobs.heartbeatRunId, run.id));
    expect(queued).toHaveLength(0);
  });

  it("materializes a runner_jobs row with materialized prompt + runtime config", async () => {
    const { company, agent, run } = await makeFixture("Materialize Co");
    const adapter = createByoRunnerAdapter(db);

    // Kick the adapter; while it polls, flip status to completed so it terminates.
    const promise = adapter.execute(
      makeCtx({
        runId: run.id,
        companyId: company.id,
        agentId: agent.id,
        timeoutSec: 5,
        promptTemplate: "Agent {{agent.name}}, run {{runId}}.",
      }),
    );

    // Wait for the row to appear — adapter inserts before the first poll.
    await new Promise((r) => setTimeout(r, 100));
    const [row] = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.heartbeatRunId, run.id));

    expect(row).toBeDefined();
    expect(row.status).toBe("queued");
    expect(row.companyId).toBe(company.id);
    expect(row.agentId).toBe(agent.id);
    expect(row.prompt).toContain("Agent Test Sarah");
    expect(row.prompt).toContain(run.id);
    expect(row.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(row.runtimeConfig)).toMatchObject({ timeoutSec: 5 });

    // Resolve the promise so vitest doesn't hang.
    await db
      .update(runnerJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        exitCode: 0,
        elapsedMs: 1234,
        costMicros: 500,
      })
      .where(eq(runnerJobs.id, row.id));
    const result = await promise;
    expect(result.exitCode).toBe(0);
  });

  it("polls until terminal (completed); returns success result", async () => {
    const { company, agent, run } = await makeFixture("Polled Complete Co");
    const adapter = createByoRunnerAdapter(db);

    const promise = adapter.execute(
      makeCtx({ runId: run.id, companyId: company.id, agentId: agent.id, timeoutSec: 5 }),
    );

    // Simulate the runner picking up the job after a brief delay.
    setTimeout(async () => {
      const [row] = await db
        .select({ id: runnerJobs.id })
        .from(runnerJobs)
        .where(eq(runnerJobs.heartbeatRunId, run.id));
      await db
        .update(runnerJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          exitCode: 0,
          elapsedMs: 2500,
          costMicros: 1_500_000, // $1.50
          sessionIdAfter: "sess_abc123",
          cliVersion: "claude 0.18.1",
        })
        .where(eq(runnerJobs.id, row.id));
    }, 1_500);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe("sess_abc123");
    expect(result.costUsd).toBeCloseTo(1.5, 2);
    expect(result.resultJson).toMatchObject({
      cliVersion: "claude 0.18.1",
      terminalStatus: "completed",
    });
  });

  it("polls until terminal (failed); returns runner_failed errorCode", async () => {
    const { company, agent, run } = await makeFixture("Polled Failed Co");
    const adapter = createByoRunnerAdapter(db);

    const promise = adapter.execute(
      makeCtx({ runId: run.id, companyId: company.id, agentId: agent.id, timeoutSec: 5 }),
    );

    setTimeout(async () => {
      const [row] = await db
        .select({ id: runnerJobs.id })
        .from(runnerJobs)
        .where(eq(runnerJobs.heartbeatRunId, run.id));
      await db
        .update(runnerJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          exitCode: 1,
          errorMessage: "claude exited with code 1: rate-limited",
        })
        .where(eq(runnerJobs.id, row.id));
    }, 1_500);

    const result = await promise;
    expect(result.errorCode).toBe("runner_failed");
    expect(result.errorMessage).toContain("rate-limited");
  });

  it("times out cleanly and marks runner_jobs row failed for late-claim safety", async () => {
    const { company, agent, run } = await makeFixture("Timeout Co");
    const adapter = createByoRunnerAdapter(db);

    // 2-second timeout; no runner ever flips the row.
    const result = await adapter.execute(
      makeCtx({ runId: run.id, companyId: company.id, agentId: agent.id, timeoutSec: 2 }),
    );

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("runner_timeout");

    const [row] = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.heartbeatRunId, run.id));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toContain("cloud-side wait timed out");
  });
});
