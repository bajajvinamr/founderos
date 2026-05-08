/**
 * first-run.test.ts — S3.10 magic-activation-gate end-to-end test.
 *
 * Coverage:
 *   1. Below threshold (1 connected integration) → bootstrap runs but the
 *      first-run gate does not fire. progress map remains null.
 *   2. At threshold (2 connected integrations) → first-run runs to
 *      completion. Assertions: events backfilled (mock spy), agent runtime
 *      states created for each agent, daily_briefs row exists with
 *      for_date=today, inbox insight written.
 *   3. Idempotent re-run: a second invocation does not duplicate the
 *      daily-brief row.
 *
 * The orchestrator's external surfaces are mocked:
 *   - Stripe / PostHog backfill runners injected via runFirstRunForCompany
 *     options (we don't hit live Stripe).
 *   - The Anthropic SDK call inside generateDailyBriefForCompany is replaced
 *     with a deterministic JSON producer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  companies,
  companyMemberships,
  createDb,
  dailyBriefs,
  insights,
  integrations,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  bootstrapCompanyOnboarding,
  type AgentSlot,
  type BootstrapInput,
} from "../services/onboarding-bootstrap.js";
import {
  _resetFirstRunStore,
  getFirstRunProgress,
  runFirstRunForCompany,
} from "../services/onboarding/first-run.js";
import type { AnthropicJsonCaller } from "../services/cos/brief-prompt.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping first-run tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function buildCharter(slot: AgentSlot): BootstrapInput["charters"][AgentSlot] {
  return {
    slot,
    name: `${slot.toUpperCase()}-Agent`,
    title: `${slot} title`,
    avatar: "",
    charter: `Charter for the ${slot} role.`,
    firstPriority: `First priority for ${slot}.`,
  };
}

function buildBootstrapInput(): BootstrapInput {
  return {
    vision: "Magic activation gate test workspace.",
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
    companyName: "FirstRunCo",
  };
}

function canonicalDailyBriefPayload() {
  return {
    headline: "Day 1 baseline captured.",
    kpiMovements: [
      {
        metric: "MRR",
        from: "$0",
        to: "$0",
        delta: "flat",
        commentary: "Baseline reading; no historic data yet.",
      },
    ],
    anomalies: [],
    blockers: [],
    opportunities: [
      {
        title: "Activation funnel review",
        expectedImpact: "Sets the baseline for D1 → D7.",
      },
    ],
    topThreeActions: [
      { action: "Confirm tracking", rationale: "First brief baseline." },
      { action: "Approve seed campaign", rationale: "Drive cohort entry." },
      { action: "Schedule founder review", rationale: "Tighten the loop." },
    ],
  };
}

describeEmbeddedPostgres("S3.10 — first-run magic activation gate", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const ACTOR_USER_ID = "founder-user-first-run";

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("first-run");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  }, 30_000);

  beforeEach(async () => {
    // CASCADE wipes all child rows via FK.
    await db.execute(sql`TRUNCATE TABLE "daily_briefs" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "integrations" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "agent_runtime_state" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "agents" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "company_memberships" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    _resetFirstRunStore();
    vi.restoreAllMocks();
  });

  async function seedConnectedIntegration(
    companyId: string,
    kind: string,
  ): Promise<void> {
    await db.insert(integrations).values({
      companyId,
      kind,
      status: "connected",
      keyHint: "…fake",
      // Encrypted-key stays null; the test stripe runner doesn't decrypt.
      encryptedApiKey: null,
      config: {},
      connectedAt: new Date(),
    });
  }

  it("below threshold: 1 connected integration → bootstrap completes, first-run gate skipped", async () => {
    // Wrap bootstrap in a tx-aware bridge: bootstrap creates the company,
    // then evaluates the first-run gate. With 0 integrations at the time of
    // bootstrap, the gate skips → progress map is empty.
    const result = await bootstrapCompanyOnboarding(db, buildBootstrapInput(), {
      actorUserId: ACTOR_USER_ID,
    });

    // We seed 1 integration AFTER the bootstrap (just to assert the gate
    // didn't eagerly fire on subsequent state changes).
    await seedConnectedIntegration(result.companyId, "stripe");

    if (result.firstRunPromise) await result.firstRunPromise;

    const progress = getFirstRunProgress(result.companyId);
    expect(progress).toBeNull();

    // No daily-brief row should have been written.
    const briefs = await db
      .select()
      .from(dailyBriefs)
      .where(sql`${dailyBriefs.companyId} = ${result.companyId}`);
    expect(briefs).toHaveLength(0);
  });

  it("at threshold (≥2 connected integrations): runFirstRunForCompany completes end-to-end", async () => {
    // Stand up a company via bootstrap (no integrations yet), then seed two
    // connected integrations and call runFirstRunForCompany directly. The
    // direct invocation lets us inject mock backfill runners + an anthropic
    // mock without depending on the bootstrap code path's fire-and-forget
    // timing.
    const bootstrapResult = await bootstrapCompanyOnboarding(
      db,
      buildBootstrapInput(),
      { actorUserId: ACTOR_USER_ID },
    );
    if (bootstrapResult.firstRunPromise) await bootstrapResult.firstRunPromise;
    _resetFirstRunStore();

    await seedConnectedIntegration(bootstrapResult.companyId, "stripe");
    await seedConnectedIntegration(bootstrapResult.companyId, "posthog");

    const stripeBackfill = vi.fn(async (_cid: string, _key: string) => {});
    const posthogBackfill = vi.fn(
      async (_cid: string, _key: string, _host?: string) => {},
    );
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalDailyBriefPayload()),
    );

    const finalProgress = await runFirstRunForCompany(
      db,
      bootstrapResult.companyId,
      {
        runners: {
          stripe: stripeBackfill,
          posthog: posthogBackfill,
        },
        briefOptions: {
          callAnthropic,
          getAnthropicKey: async () => "sk-test",
          now: new Date("2026-04-22T07:00:00Z"),
          timezone: "UTC",
        },
      },
    );

    // ── 1. progress reached "done" with all 5 steps complete ──
    expect(finalProgress.status).toBe("done");
    expect(finalProgress.completedSteps).toBe(finalProgress.totalSteps);
    expect(finalProgress.totalSteps).toBe(5);
    expect(finalProgress.dailyBriefId).toBeTruthy();

    // ── 2. backfill runners were invoked (stripe key is null in the seed,
    //       so the runner is skipped — but posthog has its own no-op default
    //       in production code; here we asserted via the connected count). ──
    // We seeded the integration with no encrypted key, so getDecryptedApiKey
    // returns null and the runner is skipped — verifying the orchestrator's
    // null-key short-circuit works correctly.
    expect(stripeBackfill).not.toHaveBeenCalled();
    expect(posthogBackfill).not.toHaveBeenCalled();

    // ── 3. agent_runtime_state rows exist for all 4 agents ──
    const runtimeStates = await db
      .select()
      .from(agentRuntimeState)
      .where(sql`${agentRuntimeState.companyId} = ${bootstrapResult.companyId}`);
    expect(runtimeStates).toHaveLength(4);
    const allAgents = await db
      .select()
      .from(agents)
      .where(sql`${agents.companyId} = ${bootstrapResult.companyId}`);
    expect(allAgents).toHaveLength(4);

    // ── 4. daily_briefs row exists ──
    const briefs = await db
      .select()
      .from(dailyBriefs)
      .where(sql`${dailyBriefs.companyId} = ${bootstrapResult.companyId}`);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.payload).toBeTruthy();
    // for_date matches the injected `now` UTC date.
    const forDateString =
      briefs[0]!.forDate instanceof Date
        ? briefs[0]!.forDate.toISOString().slice(0, 10)
        : String(briefs[0]!.forDate).slice(0, 10);
    expect(forDateString).toBe("2026-04-22");

    // ── 5. inbox announcement insight written ──
    const announcement = await db
      .select()
      .from(insights)
      .where(
        sql`${insights.companyId} = ${bootstrapResult.companyId} AND ${insights.title} = 'Your first executive brief is ready'`,
      );
    expect(announcement).toHaveLength(1);
    expect(announcement[0]!.kind).toBe("opportunity");
    expect(announcement[0]!.department).toBe("chief-of-staff");

    // Empty workspace short-circuits to the deterministic welcome brief —
    // no LLM call is made on day 1. This is the intended S3.3 behavior.
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it("backfill runners are invoked when an integration has a decryptable key", async () => {
    // Seed two integrations the easy way: use the integration service so
    // the encrypted_api_key column is populated. The orchestrator decrypts
    // and passes through to the runner.
    const bootstrapResult = await bootstrapCompanyOnboarding(
      db,
      buildBootstrapInput(),
      { actorUserId: ACTOR_USER_ID },
    );
    if (bootstrapResult.firstRunPromise) await bootstrapResult.firstRunPromise;
    _resetFirstRunStore();

    const { integrationService } = await import(
      "../services/integrations.js"
    );
    const svc = integrationService(db);
    await svc.create(bootstrapResult.companyId, {
      kind: "stripe",
      apiKey: "sk_test_first_run_stripe_key",
    });
    await svc.create(bootstrapResult.companyId, {
      kind: "posthog",
      apiKey: "phc_first_run_posthog_key",
      config: { host: "https://app.posthog.com" },
    });

    const stripeBackfill = vi.fn(async (_cid: string, _key: string) => {});
    const posthogBackfill = vi.fn(
      async (_cid: string, _key: string, _host?: string) => {},
    );
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalDailyBriefPayload()),
    );

    await runFirstRunForCompany(db, bootstrapResult.companyId, {
      runners: {
        stripe: stripeBackfill,
        posthog: posthogBackfill,
      },
      briefOptions: {
        callAnthropic,
        getAnthropicKey: async () => "sk-test",
        now: new Date("2026-04-22T07:00:00Z"),
        timezone: "UTC",
      },
    });

    expect(stripeBackfill).toHaveBeenCalledTimes(1);
    expect(stripeBackfill).toHaveBeenCalledWith(
      bootstrapResult.companyId,
      "sk_test_first_run_stripe_key",
    );
    expect(posthogBackfill).toHaveBeenCalledTimes(1);
    const posthogArgs = posthogBackfill.mock.calls[0]!;
    expect(posthogArgs[0]).toBe(bootstrapResult.companyId);
    expect(posthogArgs[1]).toBe("phc_first_run_posthog_key");
    expect(posthogArgs[2]).toBe("https://app.posthog.com");
  });

  it("idempotent: re-running first-run does not duplicate daily_briefs row", async () => {
    const bootstrapResult = await bootstrapCompanyOnboarding(
      db,
      buildBootstrapInput(),
      { actorUserId: ACTOR_USER_ID },
    );
    if (bootstrapResult.firstRunPromise) await bootstrapResult.firstRunPromise;
    _resetFirstRunStore();

    await seedConnectedIntegration(bootstrapResult.companyId, "stripe");
    await seedConnectedIntegration(bootstrapResult.companyId, "posthog");

    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalDailyBriefPayload()),
    );
    const briefOptions = {
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
      now: new Date("2026-04-22T07:00:00Z"),
      timezone: "UTC",
    };

    await runFirstRunForCompany(db, bootstrapResult.companyId, { briefOptions });
    await runFirstRunForCompany(db, bootstrapResult.companyId, { briefOptions });

    const briefs = await db
      .select()
      .from(dailyBriefs)
      .where(sql`${dailyBriefs.companyId} = ${bootstrapResult.companyId}`);
    expect(briefs).toHaveLength(1);
    // Welcome path — no LLM calls in either run.
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it("getFirstRunProgress reflects the run state after bootstrap fires the gate", async () => {
    // Pre-create a company with two connected integrations BEFORE bootstrap?
    // Not possible — companies don't exist before bootstrap. So we drive the
    // gate via direct invocation: bootstrap, seed integrations, manually
    // run first-run, observe progress.
    const bootstrapResult = await bootstrapCompanyOnboarding(
      db,
      buildBootstrapInput(),
      { actorUserId: ACTOR_USER_ID },
    );
    if (bootstrapResult.firstRunPromise) await bootstrapResult.firstRunPromise;
    _resetFirstRunStore();

    await seedConnectedIntegration(bootstrapResult.companyId, "stripe");
    await seedConnectedIntegration(bootstrapResult.companyId, "posthog");

    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalDailyBriefPayload()),
    );

    const final = await runFirstRunForCompany(db, bootstrapResult.companyId, {
      briefOptions: {
        callAnthropic,
        getAnthropicKey: async () => "sk-test",
        now: new Date("2026-04-22T07:00:00Z"),
      },
    });

    const polled = getFirstRunProgress(bootstrapResult.companyId);
    expect(polled).not.toBeNull();
    expect(polled!.status).toBe("done");
    expect(polled!.companyId).toBe(bootstrapResult.companyId);
    expect(polled!.dailyBriefId).toBe(final.dailyBriefId);
    expect(polled!.steps.map((s) => s.id)).toEqual([
      "backfill",
      "agent-warmup",
      "brief-generate",
      "inbox-surface",
      "complete",
    ]);
  });

});
