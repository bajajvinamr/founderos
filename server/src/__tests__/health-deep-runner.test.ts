/**
 * BYO-110 — /api/health/deep runner-metrics check.
 *
 * Verifies the runner_metrics check shipped in routes/health.ts:
 *   - When FOUNDEROS_BYO_RUNNER_ENABLED is unset → status="skipped".
 *   - When set with empty tables → ok with all-zero counts.
 *   - When jobs + tokens are present → counts reflect status distribution.
 *
 * Real embedded Postgres so the SQL aggregate (CASE-WHEN status sums) is
 * exercised end-to-end against the real schema. Mocked dev-server-status
 * because the / route's persisted-status read isn't relevant to /deep.
 */

import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  runnerJobs,
  runnerTokens,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { healthRoutes } from "../routes/health.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: () => undefined,
  toDevServerHealthStatus: () => undefined,
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping /health/deep runner tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /health/deep — runner_metrics (BYO-110)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let savedFlag: string | undefined;

  /** Mount /health with a fake actor middleware so session_resolver passes. */
  function makeApp() {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: { type: string } }).actor = { type: "board" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
      }),
    );
    return app;
  }

  let prefixCounter = 0;
  async function makeFixture(name: string) {
    prefixCounter += 1;
    const issuePrefix = `H${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix }).returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Health Sarah",
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

  async function makeJob(args: {
    companyId: string;
    agentId: string;
    runId: string;
    status: "queued" | "claimed" | "streaming" | "completed";
  }) {
    const [row] = await db
      .insert(runnerJobs)
      .values({
        companyId: args.companyId,
        agentId: args.agentId,
        heartbeatRunId: args.runId,
        prompt: "p",
        promptHash: "h".repeat(64),
        runtimeConfig: "{}",
        status: args.status,
      })
      .returning();
    return row;
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-health-deep-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(() => {
    savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
  });

  it("emits status='skipped' when the BYO runner flag is off", async () => {
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    const app = makeApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    const runner = (res.body.checks as Array<{ name: string; status: string; detail?: string }>).find(
      (c) => c.name === "runner_metrics",
    );
    expect(runner).toBeDefined();
    expect(runner?.status).toBe("skipped");
    expect(runner?.detail).toContain("FOUNDEROS_BYO_RUNNER_ENABLED");
  });

  it("counts jobs by status + tokens by active/online when flag is on", async () => {
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    const { company, agent, run } = await makeFixture("Metrics Co");

    // 2 queued, 1 claimed, 1 streaming (also seed a completed one to verify
    // it does NOT bleed into the in-flight buckets).
    await makeJob({ companyId: company.id, agentId: agent.id, runId: run.id, status: "queued" });
    await makeJob({ companyId: company.id, agentId: agent.id, runId: run.id, status: "queued" });
    await makeJob({ companyId: company.id, agentId: agent.id, runId: run.id, status: "claimed" });
    await makeJob({ companyId: company.id, agentId: agent.id, runId: run.id, status: "streaming" });
    await makeJob({ companyId: company.id, agentId: agent.id, runId: run.id, status: "completed" });

    // 3 active tokens; 1 online (within 30 s); 1 stale; 1 revoked (excluded).
    await db
      .insert(runnerTokens)
      .values({ companyId: company.id, tokenHash: "a".repeat(64), lastSeenAt: new Date() });
    await db.insert(runnerTokens).values({
      companyId: company.id,
      tokenHash: "b".repeat(64),
      lastSeenAt: new Date(Date.now() - 60_000),
    });
    await db.insert(runnerTokens).values({
      companyId: company.id,
      tokenHash: "c".repeat(64),
      lastSeenAt: null,
    });
    await db.insert(runnerTokens).values({
      companyId: company.id,
      tokenHash: "d".repeat(64),
      revokedAt: new Date(),
    });

    const app = makeApp();
    const res = await request(app).get("/health/deep");
    expect(res.status).toBe(200);
    const runner = (res.body.checks as Array<{ name: string; status: string; detail?: string }>).find(
      (c) => c.name === "runner_metrics",
    );
    expect(runner?.status, `runner_metrics detail=${runner?.detail}`).toBe("ok");
    // Detail format locked: jobs:queued=N,claimed=N,streaming=N; tokens:active=N,online=N
    expect(runner?.detail).toContain("queued=2");
    expect(runner?.detail).toContain("claimed=1");
    expect(runner?.detail).toContain("streaming=1");
    expect(runner?.detail).toContain("active=3");
    expect(runner?.detail).toContain("online=1");
    // Sanity: completed jobs and revoked tokens MUST NOT show up.
    expect(runner?.detail).not.toContain("completed=");
    expect(runner?.detail).not.toContain("revoked=");
  });
});
