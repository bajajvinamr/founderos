import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companyMemory,
  companySecrets,
  companySecretVersions,
  createDb,
  goals,
  projectGoals,
  projects,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  bootstrapCompanyOnboarding,
  type AgentSlot,
  type BootstrapInput,
} from "../services/onboarding-bootstrap.ts";

// Issue #11 — onboarding bootstrap atomicity.
//
// The previous implementation at server/src/routes/onboarding.ts:240-407
// called six service factories in sequence with no outer transaction.
// A failure on agent 4 left an orphan company / membership / secret /
// goal / project / 3 agents in the database. The new orchestrator at
// server/src/services/onboarding-bootstrap.ts wraps every persistent
// step in one db.transaction so a failure rolls back EVERYTHING.
//
// These tests verify three properties:
//   1. Happy path — successful bootstrap creates all expected rows.
//   2. Failure rollback — when a downstream service throws, NO orphan
//      rows are left in companies / memberships / secrets / goals /
//      projects / agents.
//   3. Retry idempotency — after a rolled-back failure the user can
//      call bootstrap again and end up with exactly one clean company.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres onboarding bootstrap tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function buildCharter(slot: AgentSlot, suffix = ""): BootstrapInput["charters"][AgentSlot] {
  return {
    slot,
    name: `${slot.toUpperCase()}-Agent${suffix}`,
    title: `${slot} title`,
    avatar: "",
    charter: `Charter for the ${slot} role.`,
    firstPriority: `First priority for ${slot}.`,
  };
}

function buildInput(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    vision: "Build a thing for founders.",
    bottlenecks: ["pmf"],
    team: "solo",
    cofounder: null,
    adapterChoice: "skip",
    anthropicKey: "",
    integrations: {},
    charters: {
      cos: buildCharter("cos"),
      growth: buildCharter("growth"),
      content: buildCharter("content"),
      finance: buildCharter("finance"),
    },
    companyName: "TestCo",
    ...overrides,
  };
}

describeEmbeddedPostgres("bootstrapCompanyOnboarding — atomic bootstrap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const ACTOR_USER_ID = "founder-user-1";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-bootstrap-atomic-");
    db = createDb(tempDb.connectionString);
    // companyMemberships.principalId is a plain text column with no FK
    // to authUsers, so no auth-user seed is needed.
  }, 20_000);

  afterEach(async () => {
    // Delete in FK-dependency order: child tables first, then companies.
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemory);
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyMemberships);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("happy path: successful bootstrap creates every expected row in one company", async () => {
    const result = await bootstrapCompanyOnboarding(db, buildInput(), {
      actorUserId: ACTOR_USER_ID,
    });

    expect(result.companyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.companyPrefix).toBeTruthy();
    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.goalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.values(result.agentIdsBySlot).every((id) => id)).toBe(true);

    // Persistent state checks:
    const allCompanies = await db.select().from(companies);
    expect(allCompanies).toHaveLength(1);
    expect(allCompanies[0].id).toBe(result.companyId);

    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, result.companyId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].principalId).toBe(ACTOR_USER_ID);
    expect(memberships[0].membershipRole).toBe("owner");

    const allGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.companyId, result.companyId));
    expect(allGoals).toHaveLength(1);
    expect(allGoals[0].id).toBe(result.goalId);

    const allProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.companyId, result.companyId));
    expect(allProjects).toHaveLength(1);
    expect(allProjects[0].id).toBe(result.projectId);

    const allAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, result.companyId));
    expect(allAgents).toHaveLength(4);

    // The two memory entries are non-critical but should be present
    // on the happy path.
    const mem = await db
      .select()
      .from(companyMemory)
      .where(eq(companyMemory.companyId, result.companyId));
    expect(mem.length).toBeGreaterThanOrEqual(1);
  });

  it("happy path: anthropic_api adapter persists a company secret", async () => {
    const result = await bootstrapCompanyOnboarding(
      db,
      buildInput({
        adapterChoice: "anthropic_api",
        anthropicKey: "sk-test-key-1234567890",
      }),
      { actorUserId: ACTOR_USER_ID },
    );

    const secrets = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, result.companyId));
    expect(secrets).toHaveLength(1);
    expect(secrets[0].name).toBe("ANTHROPIC_API_KEY");
  });

  it("rollback: a thrown error during bootstrap leaves NO rows in any of the bootstrap tables", async () => {
    // Inject a failure: spy on a real schema operation to trigger a
    // mid-transaction throw. We use a constraint that the bootstrap
    // ordinarily satisfies — by pre-existing a row that violates the
    // companies.issuePrefix uniqueness for every retry attempt, we
    // *would* trigger conflicts, but the company service has retry
    // logic for that. So instead we use vi.spyOn to override the
    // module-level service for one call.
    const agentService = await import("../services/agents.js");
    const originalAgentService = agentService.agentService;

    let agentCallCount = 0;
    vi.spyOn(agentService, "agentService").mockImplementation((...args) => {
      const real = originalAgentService(...args);
      return {
        ...real,
        create: async (companyId: string, data: never) => {
          agentCallCount += 1;
          if (agentCallCount === 3) {
            throw new Error("simulated agent insert failure on agent #3");
          }
          return real.create(companyId, data);
        },
      } as never;
    });

    let caught: unknown = null;
    try {
      await bootstrapCompanyOnboarding(db, buildInput(), {
        actorUserId: ACTOR_USER_ID,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/simulated agent insert failure/);

    // CRITICAL: rollback must have wiped every bootstrap row.
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(goals)).toHaveLength(0);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(agents)).toHaveLength(0);
    expect(await db.select().from(companyMemory)).toHaveLength(0);
  });

  it("retry idempotency: after a failed bootstrap (rolled back), a second call succeeds with a clean state", async () => {
    // Step 1: cause a failure mid-bootstrap.
    const agentService = await import("../services/agents.js");
    const originalAgentService = agentService.agentService;

    let agentCallCount = 0;
    const spy = vi.spyOn(agentService, "agentService").mockImplementation((...args) => {
      const real = originalAgentService(...args);
      return {
        ...real,
        create: async (companyId: string, data: never) => {
          agentCallCount += 1;
          if (agentCallCount === 2) {
            throw new Error("simulated mid-bootstrap failure");
          }
          return real.create(companyId, data);
        },
      } as never;
    });

    await expect(
      bootstrapCompanyOnboarding(db, buildInput(), { actorUserId: ACTOR_USER_ID }),
    ).rejects.toThrow(/simulated mid-bootstrap failure/);

    // Confirm rollback.
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(agents)).toHaveLength(0);

    // Step 2: undo the spy and retry — should succeed.
    spy.mockRestore();

    const result = await bootstrapCompanyOnboarding(db, buildInput(), {
      actorUserId: ACTOR_USER_ID,
    });

    // Final state: exactly ONE company, no duplicates.
    const finalCompanies = await db.select().from(companies);
    expect(finalCompanies).toHaveLength(1);
    expect(finalCompanies[0].id).toBe(result.companyId);

    const finalAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, result.companyId));
    expect(finalAgents).toHaveLength(4);

    const finalMemberships = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, result.companyId));
    expect(finalMemberships).toHaveLength(1);
  });

  it("rollback: failure inside the secret service still rolls back the company row", async () => {
    // Pre-condition: exercise the secret-creation path. To force a
    // throw we mock the secret service's create method.
    const secretsModule = await import("../services/secrets.js");
    const originalSecretService = secretsModule.secretService;

    vi.spyOn(secretsModule, "secretService").mockImplementation((...args) => {
      const real = originalSecretService(...args);
      return {
        ...real,
        create: async () => {
          throw new Error("simulated secret-store failure");
        },
      } as never;
    });

    await expect(
      bootstrapCompanyOnboarding(
        db,
        buildInput({
          adapterChoice: "anthropic_api",
          anthropicKey: "sk-test-key-1234567890",
        }),
        { actorUserId: ACTOR_USER_ID },
      ),
    ).rejects.toThrow(/simulated secret-store failure/);

    // The throw happens AFTER company + membership are written but
    // BEFORE goal/project/agents. Without a transaction the company
    // would persist; with the transaction wrapper, every row rolls
    // back.
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("two successive successful bootstraps produce two distinct companies (non-atomicity-related sanity check)", async () => {
    // Run 1.
    const first = await bootstrapCompanyOnboarding(
      db,
      buildInput({ companyName: "AlphaCo" }),
      { actorUserId: ACTOR_USER_ID },
    );
    // Run 2 with a different company name (and therefore a different
    // derived issue prefix). The bootstrap orchestrator does not
    // de-duplicate by user identity — each call creates a new company.
    // This pins the current product behavior so any future cross-call
    // de-dup is an explicit choice, not an accidental regression.
    const second = await bootstrapCompanyOnboarding(
      db,
      buildInput({ companyName: "BetaCo" }),
      { actorUserId: ACTOR_USER_ID },
    );

    expect(second.companyId).not.toBe(first.companyId);
    expect(second.companyPrefix).not.toBe(first.companyPrefix);

    const allCompanies = await db.select().from(companies);
    expect(allCompanies).toHaveLength(2);
    // Both have memberships for the same user — that is intentional;
    // the founder owns both companies after two bootstrap calls.
    const memberships = await db.select().from(companyMemberships);
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.principalId === ACTOR_USER_ID)).toBe(true);
  });

  it("prefix collision during a same-name bootstrap fails atomically (no orphan company on the second call)", async () => {
    // Run 1 with "ColTest" succeeds.
    const first = await bootstrapCompanyOnboarding(
      db,
      buildInput({ companyName: "ColTest" }),
      { actorUserId: ACTOR_USER_ID },
    );
    expect(first.companyId).toBeTruthy();

    // Run 2 with the SAME name → derived prefix collision.
    // companyService.create's retry loop relies on each attempt being
    // its own implicit tx; inside our orchestrator's outer tx, the
    // first conflict aborts the tx. The bootstrap fails ATOMICALLY —
    // no orphan rows. Founder must retry with a different name. This
    // is the documented behavior in the orchestrator's comments.
    let err: unknown = null;
    try {
      await bootstrapCompanyOnboarding(
        db,
        buildInput({ companyName: "ColTest" }),
        { actorUserId: ACTOR_USER_ID },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);

    // CRITICAL: only the original company exists. No partial second
    // company was committed.
    const allCompanies = await db.select().from(companies);
    expect(allCompanies).toHaveLength(1);
    expect(allCompanies[0].id).toBe(first.companyId);

    // Original 4 agents only; no orphan agents from the failed call.
    const allAgents = await db.select().from(agents);
    expect(allAgents).toHaveLength(4);
    expect(allAgents.every((a) => a.companyId === first.companyId)).toBe(true);
  });
});
