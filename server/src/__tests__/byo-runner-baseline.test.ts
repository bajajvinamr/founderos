/**
 * S8 P0.1 Phase 2C — byo_runner regression baseline.
 *
 * S8 P0.1 introduces the hosted-execution path (claude_local server-side spawn)
 * alongside the existing byo_runner laptop-runner path. The hosted rollout is
 * gated by `FOUNDEROS_HOSTED_AGENTS_ENABLED`; existing customers stay on
 * `byo_runner` indefinitely until they opt in. This test suite is the
 * canonical regression net protecting the four contracts the laptop runner
 * relies on. If any of these four scenarios silently breaks, the byo_runner
 * code path is broken — paying customers using the laptop runner today notice
 * before the rollout ships.
 *
 * Council R1 condition: "no regression on byo_runner customers (verified via
 * byo-runner-baseline.test.ts running in CI on every commit)."
 *
 * The four baseline scenarios:
 *
 *   1. Issuing a runner token works.
 *      POST /api/companies/:id/runner-tokens returns a `fos_<32 alnum>` token
 *      and persists only the sha256 hash. Plaintext is never stored.
 *
 *   2. `runner_jobs` row written when heartbeat fires for a `byo_runner`
 *      agent. Calling the byo_runner adapter materializes the row with
 *      `adapter_type='byo_runner'`, `status='queued'`, the templated prompt,
 *      and the runtime config snapshot the runner needs.
 *
 *   3. Laptop runner can claim and complete a job.
 *      POST /api/runner/jobs/:id/claim transitions queued → claimed and the
 *      complete endpoint flips it to completed with exit code + cost.
 *
 *   4. `runner_tokens.lastSeenAt` updates on every claim.
 *      The runner-auth middleware touches lastSeenAt on every authenticated
 *      request (debounced to 30s). UI liveness pill depends on this.
 *
 * Coverage relationship to existing tests:
 *   - `runner-auth.test.ts` covers token validation, expiry, and the
 *     lastSeenAt debounce mechanism in detail (BYO-101).
 *   - `runner-routes.test.ts` covers the full REST contract for all 7
 *     endpoints (BYO-104).
 *   - `byo-runner-adapter.test.ts` covers the adapter's polling state
 *     machine (BYO-103).
 *   - This file collapses the load-bearing happy paths from all three into a
 *     single canonical regression suite. If you change behavior covered here,
 *     update the matching detailed test too.
 *
 * Real embedded Postgres + real route handlers + real auth middleware. No
 * mocks. The harness uses bearer-token auth via `runnerAuthMiddleware` so
 * every claim/complete request also exercises the lastSeenAt write path.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  authUsers,
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
import { errorHandler } from "../middleware/error-handler.js";
import {
  __clearRunnerAuthDebounceCache,
  hashRunnerToken,
  runnerAuthMiddleware,
} from "../middleware/runner-auth.js";
import { runnerJobRoutes, runnerTokenManagementRoutes } from "../routes/runner.js";
import { createByoRunnerAdapter } from "../adapters/byo-runner/index.js";
import type { AdapterExecutionContext } from "@founderos/adapter-utils";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping byo_runner baseline tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("byo_runner regression baseline (S8 P0.1 Phase 2C)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // ─── Fixtures ────────────────────────────────────────────────────────────

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `BL${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  async function makeUser(id: string) {
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id,
        name: "Baseline User",
        email: `${id}@baseline.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return id;
  }

  async function makeByoRunnerAgent(companyId: string) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Baseline Sarah",
        role: "ceo",
        adapterType: "byo_runner",
        adapterConfig: {},
        status: "idle",
      })
      .returning();
    return row;
  }

  async function makeHeartbeatRun(companyId: string, agentId: string) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();
    return row;
  }

  /** Build a session-auth (board) harness app for the token-issue endpoint. */
  function adminApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId,
        companyIds: [],
        isInstanceAdmin: true,
        source: "session",
      };
      next();
    });
    app.use("/api", runnerTokenManagementRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /**
   * Build a runner-token-auth harness app. This mounts the REAL
   * `runnerAuthMiddleware` so every request to /api/runner/* exercises the
   * lastSeenAt write path. Tests pass the plaintext token in the
   * Authorization header.
   */
  function runnerApp() {
    const app = express();
    app.use(express.json());
    // Inject a synthetic requestId so the auth middleware's logger calls
    // don't trip on undefined.
    app.use((req, _res, next) => {
      (req as unknown as { requestId: string }).requestId = "baseline-test-req";
      next();
    });
    app.use("/api/runner", runnerAuthMiddleware(db), runnerJobRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** Wait for a fire-and-forget DB write to land. Mirrors the pattern in
   *  runner-auth.test.ts — the middleware kicks lastSeenAt off without
   *  awaiting, so synchronous reads can miss it. */
  async function waitForLastSeenAt(tokenId: string, deadlineMs = 5_000): Promise<Date> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const [row] = await db
        .select({ lastSeenAt: runnerTokens.lastSeenAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, tokenId));
      if (row?.lastSeenAt) return row.lastSeenAt;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `lastSeenAt did not land within ${deadlineMs}ms — middleware fire-and-forget UPDATE likely failed`,
    );
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-byo-baseline-");
    db = createDb(temp.connectionString);
    await makeUser("baseline-admin");
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  // ─── Scenario 1: Issuing a runner token works ────────────────────────────

  it("Scenario 1: issuing a runner token returns plaintext + persists sha256 hash only", async () => {
    const company = await makeCompany("Baseline Issue Co");
    const app = adminApp("baseline-admin");

    const res = await request(app)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "baseline-laptop" });

    expect(res.status).toBe(201);
    // Token format contract — runner-auth's TOKEN_FORMAT regex is
    // `^fos_[A-Za-z0-9]{32}$`. If issuance ever drifts, the runner can't
    // authenticate with the plaintext returned here.
    expect(res.body.token).toMatch(/^fos_[A-Za-z0-9]{32}$/);
    expect(res.body.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.label).toBe("baseline-laptop");

    // DB row stores hash only — plaintext must NEVER be persisted.
    const [row] = await db
      .select()
      .from(runnerTokens)
      .where(eq(runnerTokens.id, res.body.tokenId));
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.tokenHash).toBe(hashRunnerToken(res.body.token));
    // Defense in depth — the plaintext substring must not appear anywhere
    // in the persisted row's hash field.
    expect(row.tokenHash).not.toContain(res.body.token);
    expect(row.companyId).toBe(company.id);
    expect(row.revokedAt).toBeNull();
  });

  // ─── Scenario 2: runner_jobs row written for byo_runner heartbeat ────────

  it("Scenario 2: heartbeat firing for a byo_runner agent materializes a runner_jobs row", async () => {
    const company = await makeCompany("Baseline Heartbeat Co");
    const agent = await makeByoRunnerAgent(company.id);
    const run = await makeHeartbeatRun(company.id, agent.id);

    // The adapter requires the BYO runner flag. Toggle it for the duration
    // of this test only.
    const savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    try {
      const adapter = createByoRunnerAdapter(db);
      const ctx: AdapterExecutionContext = {
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
          adapterType: "byo_runner",
        } as AdapterExecutionContext["agent"],
        runtime: {} as AdapterExecutionContext["runtime"],
        config: {
          timeoutSec: 5,
          promptTemplate: "Agent {{agent.name}} run {{runId}}.",
        },
        context: {},
        onLog: async () => {
          /* baseline doesn't assert on logs */
        },
      };

      // Kick off execute(); flip the row to 'completed' from a separate
      // promise so the adapter's polling loop terminates without timing out.
      const executePromise = adapter.execute(ctx);

      // Adapter inserts the row before its first poll. Wait for it.
      let row: typeof runnerJobs.$inferSelect | undefined;
      const start = Date.now();
      while (!row && Date.now() - start < 3_000) {
        const [maybe] = await db
          .select()
          .from(runnerJobs)
          .where(eq(runnerJobs.heartbeatRunId, run.id));
        if (maybe) row = maybe;
        else await new Promise((r) => setTimeout(r, 25));
      }
      expect(row).toBeDefined();
      const inserted = row!;

      // The contract S8 P0.1 must preserve:
      expect(inserted.adapterType).toBe("byo_runner");
      expect(inserted.status).toBe("queued");
      expect(inserted.companyId).toBe(company.id);
      expect(inserted.agentId).toBe(agent.id);
      expect(inserted.heartbeatRunId).toBe(run.id);
      expect(inserted.prompt).toContain("Agent Baseline Sarah");
      expect(inserted.prompt).toContain(run.id);
      expect(inserted.promptHash).toMatch(/^[a-f0-9]{64}$/);
      const runtimeConfig = JSON.parse(inserted.runtimeConfig);
      expect(runtimeConfig).toMatchObject({ timeoutSec: 5 });

      // Resolve the adapter's polling loop so vitest doesn't hang.
      await db
        .update(runnerJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          exitCode: 0,
          elapsedMs: 100,
          costMicros: 0,
        })
        .where(eq(runnerJobs.id, inserted.id));
      const result = await executePromise;
      expect(result.exitCode).toBe(0);
    } finally {
      if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
      else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
    }
  });

  // ─── Scenario 3: laptop runner can claim and complete a job ──────────────

  it("Scenario 3: laptop runner claims a queued job and completes it via the runner endpoints", async () => {
    const company = await makeCompany("Baseline Claim Co");
    const agent = await makeByoRunnerAgent(company.id);
    const run = await makeHeartbeatRun(company.id, agent.id);

    // Issue a runner token via the management endpoint so we exercise the
    // real path (Scenario 1 already proved correctness; here we use the
    // plaintext to authenticate the runner endpoints).
    const adminAppInst = adminApp("baseline-admin");
    const issued = await request(adminAppInst)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "claim-and-complete-laptop" });
    expect(issued.status).toBe(201);
    const plaintext = issued.body.token as string;

    // Insert a queued job directly. The adapter materialization is covered
    // in Scenario 2; this scenario isolates the claim/complete contract.
    const [job] = await db
      .insert(runnerJobs)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        prompt: "baseline claim test",
        promptHash: "b".repeat(64),
        runtimeConfig: JSON.stringify({ timeoutSec: 60 }),
        adapterType: "byo_runner",
        status: "queued",
      })
      .returning();

    const app = runnerApp();

    // Claim — exercises real runnerAuthMiddleware → lookup → claim transition.
    const claim = await request(app)
      .post(`/api/runner/jobs/${job.id}/claim`)
      .set("authorization", `Bearer ${plaintext}`);
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({
      jobId: job.id,
      agentId: agent.id,
      prompt: "baseline claim test",
      adapterType: "byo_runner",
      runtimeConfig: { timeoutSec: 60 },
    });

    // Row should now be claimed by THIS token.
    const [afterClaim] = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.id, job.id));
    expect(afterClaim.status).toBe("claimed");
    expect(afterClaim.claimedByTokenId).toBe(issued.body.tokenId);

    // Complete with success.
    const complete = await request(app)
      .post(`/api/runner/jobs/${job.id}/complete`)
      .set("authorization", `Bearer ${plaintext}`)
      .send({
        status: "completed",
        exitCode: 0,
        elapsedSec: 1.25,
        costMicros: 1_500_000,
        sessionId: "sess_baseline",
        cliVersion: "claude 0.18.1",
      });
    expect(complete.status).toBe(204);

    const [afterComplete] = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.id, job.id));
    expect(afterComplete.status).toBe("completed");
    expect(afterComplete.exitCode).toBe(0);
    expect(afterComplete.costMicros).toBe(1_500_000);
    expect(afterComplete.sessionIdAfter).toBe("sess_baseline");
    expect(afterComplete.cliVersion).toBe("claude 0.18.1");
    expect(afterComplete.elapsedMs).toBe(1_250);
  });

  // ─── Scenario 4: runner_tokens.lastSeenAt updates on claim ───────────────

  it("Scenario 4: runner_tokens.lastSeenAt updates on the claim request", async () => {
    // The middleware debounces lastSeenAt writes per-token to once per 30s.
    // Clear any inherited debounce cache from prior scenarios so this test's
    // claim is guaranteed to be the first observation for its fresh token.
    __clearRunnerAuthDebounceCache();

    const company = await makeCompany("Baseline LastSeen Co");
    const agent = await makeByoRunnerAgent(company.id);
    const run = await makeHeartbeatRun(company.id, agent.id);

    // Issue a fresh token whose initial lastSeenAt MUST be null.
    const adminAppInst = adminApp("baseline-admin");
    const issued = await request(adminAppInst)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "last-seen-laptop" });
    expect(issued.status).toBe(201);
    const tokenId = issued.body.tokenId as string;
    const plaintext = issued.body.token as string;

    const [beforeAuth] = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenId));
    expect(beforeAuth.lastSeenAt).toBeNull();

    // Insert a queued job to claim — needed so the request reaches the
    // route handler instead of being short-circuited on a missing row.
    const [job] = await db
      .insert(runnerJobs)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        prompt: "last-seen baseline",
        promptHash: "c".repeat(64),
        runtimeConfig: JSON.stringify({ timeoutSec: 60 }),
        adapterType: "byo_runner",
        status: "queued",
      })
      .returning();

    const requestStartedAt = Date.now();
    const app = runnerApp();
    const claim = await request(app)
      .post(`/api/runner/jobs/${job.id}/claim`)
      .set("authorization", `Bearer ${plaintext}`);
    expect(claim.status).toBe(200);

    // The middleware fires lastSeenAt without awaiting it. Poll until the
    // write lands (or fail clearly within 5s).
    const observedSeenAt = await waitForLastSeenAt(tokenId);

    // Sanity: the lastSeenAt must have been set within the last few seconds
    // — we don't pin "within 1s" because CI fork startup can add latency
    // before the request leaves supertest, but it MUST be after the test
    // started its claim and within a generous window of "now".
    const seenAtMs = observedSeenAt.getTime();
    const nowMs = Date.now();
    expect(seenAtMs).toBeGreaterThanOrEqual(requestStartedAt);
    expect(nowMs - seenAtMs).toBeLessThan(10_000);
  });
});
