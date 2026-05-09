import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/registry.js";
import type { ServerAdapterModule } from "@founderos/adapter-utils";
import { heartbeatService } from "../services/heartbeat.ts";

// P0 silent-degradation regression test:
// When FOUNDEROS_AGENT_JWT_SECRET is unset, an adapter that declares
// supportsLocalAgentJwt:true MUST refuse to spawn — the run is marked
// failed with errorCode=agent_jwt_secret_missing and an actionable
// configuration-error message, and the adapter's execute() is NEVER
// called.
//
// Pre-fix shape: heartbeat logged a warn, set authToken=null, called
// adapter.execute({ authToken: undefined }), and the spawned subprocess
// ran without FOUNDEROS_API_KEY in env — every authenticated API call
// from the agent returned 401. Workflow blocker (RO-3 issue assignment
// to VP Marketing) surfaced as a generic "401" inside the agent's
// output instead of "your server is misconfigured."
//
// See server/src/services/heartbeat.ts:AgentJwtSecretMissingError.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat JWT-secret-fail tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TEST_ADAPTER_TYPE = "codex_local";
const ORIGINAL_JWT_SECRET = process.env.FOUNDEROS_AGENT_JWT_SECRET;

describeEmbeddedPostgres("heartbeat — FOUNDEROS_AGENT_JWT_SECRET hard-fail", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executeSpy = vi.fn();

  // Test adapter: claims supportsLocalAgentJwt:true, captures execute()
  // calls so we can assert it is or isn't invoked. Overrides the builtin
  // codex_local adapter for the duration of the test (registry restores
  // the builtin via unregisterServerAdapter).
  const testAdapter: ServerAdapterModule = {
    type: TEST_ADAPTER_TYPE,
    supportsLocalAgentJwt: true,
    models: [{ id: "test-model", label: "test" }],
    execute: async (...args) => {
      executeSpy(...args);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
      };
    },
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-jwt-secret-fail-");
    db = createDb(tempDb.connectionString);
    svc = heartbeatService(db);
    registerServerAdapter(testAdapter);
  }, 20_000);

  beforeEach(() => {
    executeSpy.mockClear();
  });

  afterEach(async () => {
    // Each test uses fresh random UUIDs for company/agent/run, so leftover
    // rows in unrelated tables don't collide. Best-effort cleanup of the
    // tables this test seeds + ones executeRun side-effects into; skip
    // companies/agents to avoid cascading-FK juggle (running heartbeat
    // service touches many child tables we don't want to enumerate here).
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.FOUNDEROS_AGENT_JWT_SECRET;
    } else {
      process.env.FOUNDEROS_AGENT_JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
    await tempDb?.cleanup();
  });

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "test",
      reason: "issue_assigned",
      payload: {},
      status: "pending",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "test",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });

    return { companyId, agentId, runId, wakeupRequestId };
  }

  async function waitForRunStatus(
    runId: string,
    desired: ReadonlyArray<string>,
    timeoutMs = 5_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await svc.getRun(runId);
      if (run && desired.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Run ${runId} did not reach status in [${desired.join(",")}] within ${timeoutMs}ms`);
  }

  it(
    "marks the run failed with errorCode=agent_jwt_secret_missing when the secret is unset and never invokes adapter.execute",
    async () => {
      delete process.env.FOUNDEROS_AGENT_JWT_SECRET;

      const { runId } = await seedQueuedRun();
      // resumeQueuedRuns triggers the executor for queued runs; the JWT
      // gate fires inside executeRun and marks the run failed.
      await svc.resumeQueuedRuns();

      const run = await waitForRunStatus(runId, ["failed", "succeeded", "cancelled"]);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("agent_jwt_secret_missing");
      // Message text comes from AgentJwtSecretMissingError in agent-auth-jwt.ts.
      // The actionable hint (`pnpm founderos onboard`) is always present in
      // production; the precise wording before that is asserted to surface
      // the env var name so an operator grepping logs finds it.
      expect(run.error).toContain("FOUNDEROS_AGENT_JWT_SECRET");
      expect(run.error).toContain("not configured");
      expect(run.error).toContain("pnpm founderos onboard");
      expect(executeSpy).not.toHaveBeenCalled();
    },
    15_000,
  );

  it(
    "proceeds normally when FOUNDEROS_AGENT_JWT_SECRET is set (regression check)",
    async () => {
      process.env.FOUNDEROS_AGENT_JWT_SECRET = "test-secret-not-empty";

      const { runId } = await seedQueuedRun();
      await svc.resumeQueuedRuns();

      const run = await waitForRunStatus(runId, ["failed", "succeeded", "cancelled"]);
      // The test adapter returns exit 0, so the run should succeed. The
      // important assertions are: NOT failed-with-jwt-secret-missing, and
      // adapter.execute WAS called with a non-undefined authToken.
      expect(run.errorCode).not.toBe("agent_jwt_secret_missing");
      expect(executeSpy).toHaveBeenCalled();
      const firstCallArgs = executeSpy.mock.calls[0]![0] as { authToken?: string };
      expect(firstCallArgs.authToken).toBeTypeOf("string");
      expect(firstCallArgs.authToken!.length).toBeGreaterThan(0);
    },
    15_000,
  );
});
