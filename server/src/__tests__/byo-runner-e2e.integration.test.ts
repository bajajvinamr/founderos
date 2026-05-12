/**
 * TA05 — BYO Runner end-to-end integration test.
 *
 * Validates the full surface end-to-end using real embedded Postgres +
 * real route handlers + real auth middleware. No mocks.
 *
 * Flow tested:
 *   1. Issue a runner token via POST /companies/:id/runner-tokens
 *      → returns plaintext fos_<32>, DB stores sha256 hash only
 *   2. Runner authenticates via Authorization: Bearer fos_...
 *      → runnerAuthMiddleware resolves token, updates lastSeenAt
 *   3. Verify lastSeenAt updated within ±5s of the request
 *   4. Adapter enqueues a runner_jobs row (via createByoRunnerAdapter)
 *      → row lands with status="queued", correct companyId/agentId
 *   5. Runner long-polls GET /api/runner/jobs/next
 *      → returns the queued job description (non-blocking: job is already there)
 *   6. Runner claims the job via POST /api/runner/jobs/:id/claim
 *      → row transitions queued → claimed
 *   7. Runner submits result via POST /api/runner/jobs/:id/complete
 *      → row transitions claimed → completed with exit code + cost
 *
 * Coverage relationship:
 *   - byo-runner-baseline.test.ts covers the four canonical regression
 *     scenarios (issue, enqueue, claim/complete, lastSeenAt).
 *   - runner-auth.test.ts covers the T1/T2 threat-model details.
 *   - runner-routes.test.ts covers the full 7-endpoint REST contract.
 *   - THIS file is the single narrative "full flow from token to complete"
 *     integration test — the clearest way to verify TA05 acceptance criteria.
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

// ─── Environment guard ──────────────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeE2E = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping byo_runner e2e tests: ${support.reason ?? "unsupported environment"}`,
  );
}

// ─── Suite ─────────────────────────────────────────────────────────────────

describeE2E("BYO Runner — full E2E flow (TA05)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // ─── Fixtures ────────────────────────────────────────────────────────────

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `E2${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  async function makeUser(id: string) {
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id,
        name: "E2E User",
        email: `${id}@e2e.test`,
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
        name: "E2E Agent Sarah",
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

  /**
   * Build a session-auth (board) harness app for the token-issue endpoint.
   * Injects a synthetic instance-admin actor so the assertCanManageRunnerTokens
   * guard passes without needing a real session.
   */
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
   * Build a runner-token-auth harness app. Mounts the REAL
   * `runnerAuthMiddleware` so every authenticated request exercises the
   * lastSeenAt write path. Pass the plaintext token as the Bearer token.
   */
  function runnerApp() {
    const app = express();
    app.use(express.json());
    // Inject a synthetic requestId so runner-auth logger calls don't trip.
    app.use((req, _res, next) => {
      (req as unknown as { requestId: string }).requestId = "e2e-test-req";
      next();
    });
    app.use("/api/runner", runnerAuthMiddleware(db), runnerJobRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /**
   * Poll until runner_tokens.lastSeenAt is non-null for `tokenId`.
   * The middleware fires the DB write without awaiting it (fire-and-forget
   * for liveness), so synchronous reads can miss the write.
   */
  async function waitForLastSeenAt(tokenId: string, deadlineMs = 5_000): Promise<Date> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const [row] = await db
        .select({ lastSeenAt: runnerTokens.lastSeenAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, tokenId));
      if (row?.lastSeenAt) return row.lastSeenAt;
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    throw new Error(
      `lastSeenAt did not land within ${deadlineMs}ms for token ${tokenId}`,
    );
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-byo-e2e-");
    db = createDb(temp.connectionString);
    await makeUser("e2e-admin");
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  // ─── Full E2E flow ────────────────────────────────────────────────────────

  it("full flow: issue token → auth + lastSeenAt update → enqueue job → long-poll → claim → complete", async () => {
    // Clear debounce cache so this test's fresh token is guaranteed to trigger
    // a lastSeenAt write on the first authenticated request.
    __clearRunnerAuthDebounceCache();

    const company = await makeCompany("E2E Full Flow Co");
    const agent = await makeByoRunnerAgent(company.id);
    const run = await makeHeartbeatRun(company.id, agent.id);
    const admin = adminApp("e2e-admin");
    const runner = runnerApp();

    // ── Step 1: Issue a runner token ────────────────────────────────────────
    // POST /api/companies/:id/runner-tokens
    // Plaintext token returned ONCE; only sha256 hash persisted in DB.
    const issueRes = await request(admin)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "e2e-laptop" });

    expect(issueRes.status).toBe(201);
    const plaintext: string = issueRes.body.token;
    const tokenId: string = issueRes.body.tokenId;

    // Token format: fos_ + exactly 32 alphanumeric chars (TOKEN_FORMAT regex
    // in runner-auth.ts). If this drifts, the runner can't authenticate.
    expect(plaintext).toMatch(/^fos_[A-Za-z0-9]{32}$/);
    expect(issueRes.body.label).toBe("e2e-laptop");

    // DB row MUST store sha256 hash only — plaintext never persisted.
    const [storedRow] = await db
      .select({ tokenHash: runnerTokens.tokenHash, lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenId));
    expect(storedRow.tokenHash).toBe(hashRunnerToken(plaintext));
    expect(storedRow.lastSeenAt).toBeNull(); // never seen yet

    // ── Step 2: Enqueue a job via the byo_runner adapter ───────────────────
    // The adapter materializes a runner_jobs row instead of spawning anything.
    const savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    let jobId: string;
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
          timeoutSec: 10,
          promptTemplate: "TA05 e2e prompt for {{agent.name}} run {{runId}}.",
        },
        context: {},
        onLog: async () => {
          /* no-op for test */
        },
      };

      // Kick off execute() — it will block waiting for the job to reach a
      // terminal state. We resolve it from a parallel branch below.
      const executePromise = adapter.execute(ctx);

      // Wait for the runner_jobs row to appear (adapter inserts before first poll).
      let foundRow: typeof runnerJobs.$inferSelect | undefined;
      const rowDeadline = Date.now() + 3_000;
      while (!foundRow && Date.now() < rowDeadline) {
        const [maybe] = await db
          .select()
          .from(runnerJobs)
          .where(eq(runnerJobs.heartbeatRunId, run.id));
        if (maybe) foundRow = maybe;
        else await new Promise<void>((r) => setTimeout(r, 25));
      }

      expect(foundRow).toBeDefined();
      jobId = foundRow!.id;

      // ── Step 3: Verify the job row contract ────────────────────────────────
      expect(foundRow!.status).toBe("queued");
      expect(foundRow!.companyId).toBe(company.id);
      expect(foundRow!.agentId).toBe(agent.id);
      expect(foundRow!.adapterType).toBe("byo_runner");
      expect(foundRow!.prompt).toContain("E2E Agent Sarah");
      expect(foundRow!.promptHash).toMatch(/^[a-f0-9]{64}$/);
      const runtimeConfig = JSON.parse(foundRow!.runtimeConfig);
      expect(runtimeConfig).toMatchObject({ timeoutSec: 10 });

      // ── Step 4: Runner long-polls for next job ─────────────────────────────
      // The job is already queued, so the long-poll returns immediately.
      const pollRes = await request(runner)
        .get("/api/runner/jobs/next")
        .set("authorization", `Bearer ${plaintext}`);

      expect(pollRes.status).toBe(200);
      expect(pollRes.body).toMatchObject({
        jobId,
        agentId: agent.id,
      });

      // ── Step 5: Verify lastSeenAt updated after the poll request ───────────
      // The runnerAuthMiddleware writes lastSeenAt on every authenticated
      // request (debounced to 30s). The poll above was the first auth.
      const observedSeenAt = await waitForLastSeenAt(tokenId);
      const seenAtMs = observedSeenAt.getTime();
      const nowMs = Date.now();
      expect(seenAtMs).toBeGreaterThan(0);
      // Must have been set within the last 10s (generous for CI latency).
      expect(nowMs - seenAtMs).toBeLessThan(10_000);

      // ── Step 6: Runner claims the job ──────────────────────────────────────
      const claimRes = await request(runner)
        .post(`/api/runner/jobs/${jobId}/claim`)
        .set("authorization", `Bearer ${plaintext}`);

      expect(claimRes.status).toBe(200);
      expect(claimRes.body).toMatchObject({
        jobId,
        agentId: agent.id,
        prompt: expect.stringContaining("E2E Agent Sarah"),
        adapterType: "byo_runner",
        runtimeConfig: { timeoutSec: 10 },
      });

      const [afterClaim] = await db
        .select({ status: runnerJobs.status, claimedByTokenId: runnerJobs.claimedByTokenId })
        .from(runnerJobs)
        .where(eq(runnerJobs.id, jobId));
      expect(afterClaim.status).toBe("claimed");
      expect(afterClaim.claimedByTokenId).toBe(tokenId);

      // ── Step 7: Runner submits result ──────────────────────────────────────
      const completeRes = await request(runner)
        .post(`/api/runner/jobs/${jobId}/complete`)
        .set("authorization", `Bearer ${plaintext}`)
        .send({
          status: "completed",
          exitCode: 0,
          elapsedSec: 2.5,
          costMicros: 750_000,
          sessionId: "sess_e2e_ta05",
          cliVersion: "claude 0.19.0",
        });

      expect(completeRes.status).toBe(204);

      const [afterComplete] = await db
        .select()
        .from(runnerJobs)
        .where(eq(runnerJobs.id, jobId));
      expect(afterComplete.status).toBe("completed");
      expect(afterComplete.exitCode).toBe(0);
      expect(afterComplete.costMicros).toBe(750_000);
      expect(afterComplete.sessionIdAfter).toBe("sess_e2e_ta05");
      expect(afterComplete.cliVersion).toBe("claude 0.19.0");
      expect(afterComplete.elapsedMs).toBe(2_500);

      // ── Step 8: Adapter polling loop resolves with the terminal state ───────
      // The execute() promise is still polling; flip the row to completed so
      // it resolves cleanly. (We already flipped it via /complete above —
      // just need to wait for the execute() loop to pick it up.)
      const result = await executePromise;
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeUndefined();
    } finally {
      if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
      else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
    }
  });

  // ─── Auth rejection tests ─────────────────────────────────────────────────

  it("rejects a runner request with an invalid token format", async () => {
    const runner = runnerApp();
    const res = await request(runner)
      .get("/api/runner/jobs/next")
      .set("authorization", "Bearer notavalidtoken");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_runner_token");
  });

  it("rejects a revoked token", async () => {
    __clearRunnerAuthDebounceCache();
    const company = await makeCompany("E2E Revoke Co");
    const admin = adminApp("e2e-admin");
    const runner = runnerApp();

    // Issue a token
    const issueRes = await request(admin)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "revoke-test" });
    expect(issueRes.status).toBe(201);
    const plaintext: string = issueRes.body.token;
    const tokenId: string = issueRes.body.tokenId;

    // Revoke it
    const revokeRes = await request(admin)
      .delete(`/api/companies/${company.id}/runner-tokens/${tokenId}`);
    expect(revokeRes.status).toBe(204);

    // Attempt to use the revoked token — must be 401
    const pollRes = await request(runner)
      .get("/api/runner/jobs/next")
      .set("authorization", `Bearer ${plaintext}`);
    expect(pollRes.status).toBe(401);
    expect(pollRes.body.error).toBe("invalid_runner_token");
  });

  // ─── Runner status endpoint ───────────────────────────────────────────────

  it("GET /companies/:id/runner-status reflects online state after a runner request", async () => {
    __clearRunnerAuthDebounceCache();
    const company = await makeCompany("E2E Status Co");
    const agent = await makeByoRunnerAgent(company.id);
    const run = await makeHeartbeatRun(company.id, agent.id);
    const admin = adminApp("e2e-admin");
    const runner = runnerApp();

    // Issue token — initial lastSeenAt is null so status is offline
    const issueRes = await request(admin)
      .post(`/api/companies/${company.id}/runner-tokens`)
      .send({ label: "status-test" });
    expect(issueRes.status).toBe(201);
    const plaintext: string = issueRes.body.token;
    const tokenId: string = issueRes.body.tokenId;

    // Status before any runner request: token exists but not online
    const beforeStatus = await request(admin).get(`/api/companies/${company.id}/runner-status`);
    expect(beforeStatus.status).toBe(200);
    const beforeTokens: Array<{ tokenId: string; online: boolean }> = beforeStatus.body.tokens;
    const beforeToken = beforeTokens.find((t) => t.tokenId === tokenId);
    expect(beforeToken?.online).toBe(false);

    // Insert a queued job so the claim endpoint returns immediately.
    // We use the claim endpoint (not long-poll) because long-poll blocks 30s
    // when there are no jobs, which would exceed the default test timeout.
    const [job] = await db
      .insert(runnerJobs)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        prompt: "status test prompt",
        promptHash: "d".repeat(64),
        runtimeConfig: JSON.stringify({ timeoutSec: 60 }),
        adapterType: "byo_runner",
        status: "queued",
      })
      .returning();

    // Claim the job — the runnerAuthMiddleware fires the lastSeenAt write
    // as a side-effect of authenticating the request.
    const claimRes = await request(runner)
      .post(`/api/runner/jobs/${job.id}/claim`)
      .set("authorization", `Bearer ${plaintext}`);
    expect(claimRes.status).toBe(200);

    // Wait for the fire-and-forget lastSeenAt write to land
    await waitForLastSeenAt(tokenId);

    // Status after runner auth — the token must now show online=true
    const afterStatus = await request(admin).get(`/api/companies/${company.id}/runner-status`);
    expect(afterStatus.status).toBe(200);
    const afterTokens: Array<{ tokenId: string; online: boolean; lastSeenAt: string | null }> =
      afterStatus.body.tokens;
    const afterToken = afterTokens.find((t) => t.tokenId === tokenId);
    expect(afterToken).toBeDefined();
    expect(afterToken?.online).toBe(true);
    expect(afterToken?.lastSeenAt).toBeTruthy();
  });
});
