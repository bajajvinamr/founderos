/**
 * TC-3 — Tenant invariants migration smoke (council 2026-05-05 R1+R2 P2).
 *
 * Verifies that migration 0085_tenant_invariants applies cleanly and that
 * the four child tables (runner_jobs, heartbeat_runs, issue_labels,
 * execution_workspaces) reject:
 *
 *   1. Cross-tenant inserts where (company_id, parent_id) do not refer to
 *      a same-company parent — composite FK violation.
 *   2. Out-of-enum status values — CHECK constraint violation.
 *
 * Why both branches matter: Drizzle's $type<>() casts erase at runtime.
 * Direct `db.execute(sql\`INSERT ...\`)` paths, hand-written migrations, and
 * any future agent-generated code that bypasses the typed insert builder
 * will rely entirely on the DB-layer constraint to reject malformed data.
 *
 * Same shape as runner-tables-migration.test.ts: real embedded Postgres,
 * real Drizzle, real FK + CHECK enforcement.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
  projects,
  runnerJobs,
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
    `Skipping tenant-invariants migration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("0085_tenant_invariants migration smoke", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-tenant-invariants-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Per-test prefix counter: companies.issuePrefix has a UNIQUE index.
  // Generate a fresh prefix per company so this suite can stand up many
  // tenants in one run without colliding with other suites in the shared DB.
  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `T${Date.now().toString(36).slice(-4).toUpperCase()}${prefixCounter}`;
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

  async function makeAgent(companyId: string, name = "Test Agent") {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "ceo",
        adapterType: "byo_runner",
        adapterConfig: {},
        status: "idle",
      })
      .returning();
    return row;
  }

  // --------------------------------------------------------------------
  // runner_jobs
  // --------------------------------------------------------------------

  it("runner_jobs: rejects cross-tenant agent_id via composite FK", async () => {
    const companyA = await makeCompany("Tenant A");
    const companyB = await makeCompany("Tenant B");
    const agentB = await makeAgent(companyB.id, "Agent in B");
    const [runA] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: companyA.id,
        // agentId points back to companyA — make a dedicated agent
        agentId: (await makeAgent(companyA.id, "Agent in A")).id,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();

    // Try to insert a runner_job in companyA that references an agent from
    // companyB. Composite FK must reject this even though both single-column
    // FKs (agent.id exists, heartbeat_run.id exists, company.id exists) are
    // individually satisfied.
    await assertDbErrorMatches(
      db.insert(runnerJobs).values({
        companyId: companyA.id,
        agentId: agentB.id, // wrong tenant
        heartbeatRunId: runA.id,
        prompt: "p",
        promptHash: "0".repeat(64),
        runtimeConfig: "{}",
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("runner_jobs: rejects cross-tenant heartbeat_run_id via composite FK", async () => {
    const companyA = await makeCompany("Tenant A2");
    const companyB = await makeCompany("Tenant B2");
    const agentA = await makeAgent(companyA.id);
    const agentB = await makeAgent(companyB.id);

    const [runB] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: companyB.id,
        agentId: agentB.id,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();

    await assertDbErrorMatches(
      db.insert(runnerJobs).values({
        companyId: companyA.id,
        agentId: agentA.id,
        heartbeatRunId: runB.id, // wrong tenant
        prompt: "p",
        promptHash: "1".repeat(64),
        runtimeConfig: "{}",
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("runner_jobs: rejects out-of-enum status via CHECK", async () => {
    const company = await makeCompany("Status Co");
    const agent = await makeAgent(company.id);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();

    // Bypass Drizzle's $type<>() compile-time guard via raw SQL — this is
    // the path the CHECK constraint is the last line of defense for.
    await assertDbErrorMatches(
      db.execute(sql`
        INSERT INTO runner_jobs (
          company_id, agent_id, heartbeat_run_id, prompt, prompt_hash, runtime_config, status
        ) VALUES (
          ${company.id}, ${agent.id}, ${run.id}, 'p', ${"2".repeat(64)}, '{}', 'invalid_status'
        )
      `),
      /check constraint|violates|status_check/i,
    );
  });

  it("runner_jobs: accepts canonical same-tenant insert", async () => {
    const company = await makeCompany("Happy Path Co");
    const agent = await makeAgent(company.id);
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
        prompt: "p",
        promptHash: "3".repeat(64),
        runtimeConfig: "{}",
      })
      .returning();

    expect(job.status).toBe("queued");
    expect(job.companyId).toBe(company.id);
  });

  // --------------------------------------------------------------------
  // heartbeat_runs
  // --------------------------------------------------------------------

  it("heartbeat_runs: rejects cross-tenant agent_id via composite FK", async () => {
    const companyA = await makeCompany("HR Tenant A");
    const companyB = await makeCompany("HR Tenant B");
    const agentB = await makeAgent(companyB.id);

    await assertDbErrorMatches(
      db.insert(heartbeatRuns).values({
        companyId: companyA.id,
        agentId: agentB.id, // wrong tenant
        invocationSource: "on_demand",
        status: "queued",
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("heartbeat_runs: rejects out-of-enum status via CHECK", async () => {
    const company = await makeCompany("HR Status Co");
    const agent = await makeAgent(company.id);

    await assertDbErrorMatches(
      db.execute(sql`
        INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status)
        VALUES (${company.id}, ${agent.id}, 'on_demand', 'bogus')
      `),
      /check constraint|violates|status_check/i,
    );
  });

  it("heartbeat_runs: accepts coalesced status (heartbeat-scheduler-only)", async () => {
    // 'coalesced' is not in HEARTBEAT_RUN_STATUSES but the heartbeat
    // scheduler writes it (server/src/services/heartbeat.ts:3161, :3344).
    // Migration 0085 includes it in the CHECK constraint to avoid a hard
    // regression on the wakeup-coalescing code path.
    const company = await makeCompany("Coalesce Co");
    const agent = await makeAgent(company.id);

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "on_demand",
        status: "coalesced",
      })
      .returning();

    expect(run.status).toBe("coalesced");
  });

  // --------------------------------------------------------------------
  // issue_labels
  // --------------------------------------------------------------------

  it("issue_labels: rejects cross-tenant issue_id via composite FK", async () => {
    const companyA = await makeCompany("IL Tenant A");
    const companyB = await makeCompany("IL Tenant B");

    const [issueB] = await db
      .insert(issues)
      .values({
        companyId: companyB.id,
        title: "B issue",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const [labelA] = await db
      .insert(labels)
      .values({ companyId: companyA.id, name: "label-a", color: "#000" })
      .returning();

    await assertDbErrorMatches(
      db.insert(issueLabels).values({
        companyId: companyA.id,
        issueId: issueB.id, // wrong tenant
        labelId: labelA.id,
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("issue_labels: rejects cross-tenant label_id via composite FK", async () => {
    const companyA = await makeCompany("IL Tenant A2");
    const companyB = await makeCompany("IL Tenant B2");

    const [issueA] = await db
      .insert(issues)
      .values({
        companyId: companyA.id,
        title: "A issue",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const [labelB] = await db
      .insert(labels)
      .values({ companyId: companyB.id, name: "label-b", color: "#fff" })
      .returning();

    await assertDbErrorMatches(
      db.insert(issueLabels).values({
        companyId: companyA.id,
        issueId: issueA.id,
        labelId: labelB.id, // wrong tenant
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("issue_labels: accepts canonical same-tenant insert", async () => {
    const company = await makeCompany("IL Happy Co");
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Issue",
        status: "todo",
        priority: "medium",
      })
      .returning();
    const [label] = await db
      .insert(labels)
      .values({ companyId: company.id, name: "ok-label", color: "#888" })
      .returning();

    const [link] = await db
      .insert(issueLabels)
      .values({
        companyId: company.id,
        issueId: issue.id,
        labelId: label.id,
      })
      .returning();

    expect(link.companyId).toBe(company.id);
  });

  // --------------------------------------------------------------------
  // execution_workspaces
  // --------------------------------------------------------------------

  it("execution_workspaces: rejects cross-tenant project_id via composite FK", async () => {
    const companyA = await makeCompany("EW Tenant A");
    const companyB = await makeCompany("EW Tenant B");
    const [projectB] = await db
      .insert(projects)
      .values({ companyId: companyB.id, name: "B project" })
      .returning();

    await assertDbErrorMatches(
      db.insert(executionWorkspaces).values({
        companyId: companyA.id,
        projectId: projectB.id, // wrong tenant
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "leaky workspace",
        status: "active",
        providerType: "local_fs",
      }),
      /foreign key|violates|constraint/i,
    );
  });

  it("execution_workspaces: rejects out-of-enum status via CHECK", async () => {
    const company = await makeCompany("EW Status Co");
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "P" })
      .returning();

    await assertDbErrorMatches(
      db.execute(sql`
        INSERT INTO execution_workspaces (
          company_id, project_id, mode, strategy_type, name, status, provider_type
        ) VALUES (
          ${company.id}, ${project.id}, 'shared_workspace', 'project_primary',
          'bad-status workspace', 'unknown_state', 'local_fs'
        )
      `),
      /check constraint|violates|status_check/i,
    );
  });

  it("execution_workspaces: accepts canonical same-tenant insert", async () => {
    const company = await makeCompany("EW Happy Co");
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Happy Project" })
      .returning();

    const [ws] = await db
      .insert(executionWorkspaces)
      .values({
        companyId: company.id,
        projectId: project.id,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Workspace",
        status: "active",
        providerType: "local_fs",
      })
      .returning();

    expect(ws.companyId).toBe(company.id);
    expect(ws.status).toBe("active");
  });

  // Suppress unused-import warning when typecheck includes auth helper
  // (kept available for potential future actor-tagged tests).
  void makeUser;
});
