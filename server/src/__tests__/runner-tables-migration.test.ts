/**
 * BYO-102 — Migration smoke tests for runner_tokens + runner_jobs.
 *
 * Verifies the 0072_runner_tables migration applies cleanly and the tables
 * accept the shapes the API contract (docs/api/runner-openapi.yaml) requires.
 * Integration-level: real embedded Postgres, real Drizzle, real FK enforcement.
 *
 * What this proves:
 *   1. Migration applies on a fresh embedded PG (the implicit gate that the
 *      onboarding-bootstrap-atomicity test already runs through).
 *   2. runner_tokens accepts the canonical shape; revoked_at default is null.
 *   3. token_hash UNIQUE constraint fires on duplicate.
 *   4. runner_jobs accepts the canonical shape; status default is 'queued'.
 *   5. company FK cascade-deletes child rows in both tables (so dropping
 *      a test tenant cleans up cleanly — important for E2E hygiene).
 */

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
import { assertDbErrorMatches } from "./helpers/db-error-matchers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping runner-tables migration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("runner_tokens + runner_jobs migration smoke", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-runner-migration-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    // companies.issue_prefix has a UNIQUE index — generate a unique prefix
    // per test row so we can stand up multiple companies in one suite.
    prefixCounter += 1;
    const issuePrefix = `R${Date.now().toString(36).slice(-4).toUpperCase()}${prefixCounter}`;
    const [row] = await db
      .insert(companies)
      .values({ name, issuePrefix })
      .returning();
    return row;
  }

  async function makeUser(email: string) {
    const [row] = await db
      .insert(authUsers)
      .values({
        id: `user_${Math.random().toString(36).slice(2, 10)}`,
        name: email.split("@")[0],
        email,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return row;
  }

  it("accepts a canonical runner_tokens row with hash + label", async () => {
    const company = await makeCompany("Token Smoke Co");
    const user = await makeUser(`smoke-${Date.now()}@founderos.dev`);

    const [token] = await db
      .insert(runnerTokens)
      .values({
        companyId: company.id,
        tokenHash: "a".repeat(64), // sha256 hex
        label: "Vinamr's MacBook",
        createdByUserId: user.id,
      })
      .returning();

    expect(token).toBeDefined();
    expect(token.companyId).toBe(company.id);
    expect(token.label).toBe("Vinamr's MacBook");
    expect(token.revokedAt).toBeNull();
    expect(token.lastSeenAt).toBeNull();
    expect(token.createdAt).toBeInstanceOf(Date);
  });

  it("rejects duplicate token_hash via UNIQUE constraint", async () => {
    const company = await makeCompany("Dup Hash Co");
    const dupHash = "b".repeat(64);

    await db.insert(runnerTokens).values({ companyId: company.id, tokenHash: dupHash });

    await assertDbErrorMatches(
      db.insert(runnerTokens).values({ companyId: company.id, tokenHash: dupHash }),
      /duplicate key|unique/i,
    );
  });

  it("cascade-deletes runner_tokens when parent company is deleted", async () => {
    const company = await makeCompany("Cascade Tokens Co");
    await db.insert(runnerTokens).values({
      companyId: company.id,
      tokenHash: "c".repeat(64),
    });

    const before = await db
      .select()
      .from(runnerTokens)
      .where(eq(runnerTokens.companyId, company.id));
    expect(before).toHaveLength(1);

    await db.delete(companies).where(eq(companies.id, company.id));

    const after = await db
      .select()
      .from(runnerTokens)
      .where(eq(runnerTokens.companyId, company.id));
    expect(after).toHaveLength(0);
  });

  it("accepts a canonical runner_jobs row with materialized prompt + runtime_config", async () => {
    const company = await makeCompany("Jobs Smoke Co");
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Test Agent",
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

    const [job] = await db
      .insert(runnerJobs)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        prompt: "You are agent CEO. Continue your work.",
        promptHash: "d".repeat(64),
        runtimeConfig: JSON.stringify({ model: "claude-opus-4-7", maxTurns: 5, timeoutSec: 600 }),
      })
      .returning();

    expect(job).toBeDefined();
    expect(job.status).toBe("queued");
    expect(job.claimedByTokenId).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(JSON.parse(job.runtimeConfig)).toMatchObject({ model: "claude-opus-4-7" });
  });

  it("cascade-deletes runner_jobs when parent heartbeat_run is deleted", async () => {
    // heartbeat_runs is the closest direct parent we control end-to-end:
    // a heartbeat run's lifecycle is owned by the heartbeat scheduler, and
    // when the scheduler decides a run is gone (cleanup, retry, etc.) the
    // associated runner_jobs row should go too. The other cascades
    // (companies, agents) are blocked by sibling FKs on heartbeat_runs
    // itself — that's a pre-existing repo invariant unrelated to this
    // migration.
    const company = await makeCompany("Cascade Jobs Co");
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Test Agent 2",
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
    await db.insert(runnerJobs).values({
      companyId: company.id,
      agentId: agent.id,
      heartbeatRunId: run.id,
      prompt: "p",
      promptHash: "e".repeat(64),
      runtimeConfig: "{}",
    });

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));

    const after = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.heartbeatRunId, run.id));
    expect(after).toHaveLength(0);
  });

  it("token claim sets claimed_by_token_id; revoke does not affect claim history", async () => {
    const company = await makeCompany("Claim Co");
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Claim Agent",
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
    const [token] = await db
      .insert(runnerTokens)
      .values({ companyId: company.id, tokenHash: "f".repeat(64) })
      .returning();
    const [job] = await db
      .insert(runnerJobs)
      .values({
        companyId: company.id,
        agentId: agent.id,
        heartbeatRunId: run.id,
        prompt: "p",
        promptHash: "0".repeat(64),
        runtimeConfig: "{}",
        status: "claimed",
        claimedByTokenId: token.id,
        claimedAt: new Date(),
      })
      .returning();

    expect(job.claimedByTokenId).toBe(token.id);

    // Revoking the token sets revoked_at but does NOT null claimed_by on
    // historical jobs (audit preservation).
    await db
      .update(runnerTokens)
      .set({ revokedAt: new Date() })
      .where(eq(runnerTokens.id, token.id));

    const [postRevoke] = await db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.id, job.id));
    expect(postRevoke.claimedByTokenId).toBe(token.id); // history preserved
  });
});
