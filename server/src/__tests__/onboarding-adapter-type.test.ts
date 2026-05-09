/**
 * Tests that POST /onboarding/bootstrap always creates agents with
 * adapterType = "claude_local", regardless of the adapterChoice field.
 *
 * This covers the P1-2 council finding: the original code mapped
 * "anthropic_api" → "claude_api" but no claude_api adapter is registered,
 * making those agents permanently non-functional.  The fix hardcodes
 * "claude_local" for all paths.
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "company-uuid-1", name: "Test Co" }),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn().mockResolvedValue(undefined),
}));

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "secret-uuid-1" }),
}));

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "agent-uuid-1" }),
}));

const mockGoalService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "goal-uuid-1" }),
}));

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "project-uuid-1" }),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "issue-uuid-1" }),
}));

const mockMemoryService = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue(undefined),
}));

const mockValidateAnthropicKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ valid: true }),
);

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn().mockResolvedValue({}),
  getExperimental: vi.fn().mockResolvedValue({}),
  updateGeneral: vi.fn().mockResolvedValue({ id: "instance-settings-1", general: {} }),
  updateExperimental: vi.fn().mockResolvedValue({ id: "instance-settings-1", experimental: {} }),
  listCompanyIds: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue({}),
}));

// Council-2026-05-05 R1 (PR #35) — onboarding route checks subscription
// status to gate the analytics-integration requirement. The route imports
// subscriptionService directly (not via services/index.js), so we stub it
// here to return inactive (free tier) — bypassing the gate is the
// conservative default for these mock-based tests.
vi.mock("../services/subscription.js", () => ({
  subscriptionService: () => ({
    getCurrentSubscription: vi.fn().mockResolvedValue(null),
    isSubscriptionActive: vi.fn().mockResolvedValue(false),
  }),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  accessService: () => mockAccessService,
  secretService: () => mockSecretService,
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  companyMemoryService: () => mockMemoryService,
  // S-TC1 — onboarding now persists telemetry consent into instance
  // settings. Mocked here so the bootstrap route can resolve the service.
  instanceSettingsService: () => mockInstanceSettingsService,
  validateAnthropicKey: mockValidateAnthropicKey,
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "local-user",
    companyIds: [],
    source: "local_implicit",
    isInstanceAdmin: false,
    ...overrides,
  };
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ onboardingRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/onboarding.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor(actorOverrides);
    next();
  });
  // The bootstrap orchestrator now wraps its work in db.transaction.
  // Provide a no-op transaction stub that just runs the callback so
  // these mock-based tests still exercise the route logic. The
  // services themselves are mocked above (vi.mock), so no real DB is
  // needed.
  const fakeDb: Record<string, unknown> = {};
  fakeDb.transaction = async (cb: (tx: unknown) => unknown) => cb(fakeDb);
  // S3.10 magic-gate added `txDb.insert(workspaceDepartments).values([...])`
  // inside the bootstrap transaction. Stub a chainable insert that no-ops —
  // mock-based tests don't observe the row, only that the route returns 201.
  fakeDb.insert = () => ({
    values: async () => undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", onboardingRoutes(fakeDb as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Shared test payload factory
// ---------------------------------------------------------------------------

const charterSlot = (slot: string) => ({
  slot,
  name: `${slot} agent`,
  title: `${slot} title`,
  charter: "Do great work every day",
  firstPriority: "Start immediately",
});

function makePayload(
  adapterChoice: string,
  anthropicKey = "",
) {
  return {
    vision:
      "We are building an AI-native startup management tool for founders who want to move fast.",
    bottlenecks: ["pmf"],
    team: "solo",
    adapterChoice,
    anthropicKey,
    integrations: {},
    charters: {
      cos: charterSlot("cos"),
      growth: charterSlot("growth"),
      content: charterSlot("content"),
      finance: charterSlot("finance"),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — adapterType is always claude_local", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // BYO-107: the flag-aware mapping returns "byo_runner" when set; the
    // existing assertions cover the flag-OFF branch, so explicitly disable.
    savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
  });

  it("creates agents with adapterType=claude_local when adapterChoice=claude_local", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);

    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4); // one per slot
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
  });

  it("allows a normal signed-in SaaS user to create their first company without instance-admin role", async () => {
    const app = await createApp({ source: "session", isInstanceAdmin: false });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      "company-uuid-1",
      "user",
      "local-user",
      "owner",
      "active",
    );
  });

  it("creates agents with adapterType=claude_local when adapterChoice=anthropic_api", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);

    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      // The fix: must be "claude_local", NOT "claude_api"
      expect(payload).toMatchObject({ adapterType: "claude_local" });
      expect(payload.adapterType).not.toBe("claude_api");
    }
  });

  it("creates agents with adapterType=claude_local when adapterChoice=skip", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("skip"));

    expect(res.status).toBe(201);

    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
  });

  it("injects anthropic secret into adapterConfig when anthropic_api key is valid", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });
    mockSecretService.create.mockResolvedValue({ id: "secret-uuid-99" });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);

    // Secret should have been created once
    expect(mockSecretService.create).toHaveBeenCalledTimes(1);

    // All four agents should carry the secret ref in their adapterConfig env
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      expect(payload.adapterConfig.env.ANTHROPIC_API_KEY).toMatchObject({
        type: "secret_ref",
        secretId: "secret-uuid-99",
      });
    }
  });

  it("does NOT create a secret when adapterChoice=claude_local", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    expect(mockSecretService.create).not.toHaveBeenCalled();

    // adapterConfig env should be empty — no key injection
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      expect(payload.adapterConfig).toMatchObject({ env: {} });
    }
  });

  it("rejects anthropic_api when key is missing", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", ""));

    expect(res.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects anthropic_api when key fails validation", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({
      valid: false,
      reason: "Invalid API key format",
    });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-bad-key-1234567890"));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Anthropic API key rejected");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BYO-107 — flag-on path: every adapterChoice maps to byo_runner
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — adapterType is byo_runner when FOUNDEROS_BYO_RUNNER_ENABLED=1", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
  });

  it("maps adapterChoice=claude_local → byo_runner", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "byo_runner" });
    }
  });

  it("maps adapterChoice=anthropic_api → byo_runner (key still stored as secret)", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });
    mockSecretService.create.mockResolvedValue({ id: "secret-uuid-byo" });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    expect(mockSecretService.create).toHaveBeenCalledTimes(1);

    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "byo_runner" });
    }
  });

  it("maps adapterChoice=skip → byo_runner", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("skip"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "byo_runner" });
    }
  });
});

// ---------------------------------------------------------------------------
// S7.0.2 — Zod schema accepts the wider 7 CLI choices
//
// We only assert that the schema VALIDATES the wider input — the
// downstream "agents end up with adapterType=X" behavior is gated by
// onboarding-bootstrap.ts:307 (still collapses to claude_local or
// byo_runner per the BYO flag); S7.2 will reverse that collapse and
// add behavior tests here.
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — Zod adapterChoice schema accepts wider CLI set (S7.0.2)", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedFlag = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedFlag;
  });

  // Each of the 7 CLI choices should pass Zod validation (HTTP 201).
  const cliChoices = [
    "codex_local",
    "gemini_local",
    "opencode_local",
    "pi_local",
    "cursor_local",
    "hermes_local",
  ] as const;

  for (const choice of cliChoices) {
    it(`accepts adapterChoice=${choice} (no anthropic key required)`, async () => {
      const app = await createApp();
      const res = await request(app)
        .post("/api/onboarding/bootstrap")
        .send(makePayload(choice));

      // 201 = Zod accepted + downstream pipeline ran.
      expect(res.status).toBe(201);
      // No key validation should have fired for a CLI choice.
      expect(mockValidateAnthropicKey).not.toHaveBeenCalled();
      // No company secret should have been created — only anthropic_api
      // path stores the key.
      expect(mockSecretService.create).not.toHaveBeenCalled();
    });
  }

  it("rejects adapterChoice=not_a_real_cli with 400 (Zod validation error)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("not_a_real_cli"));

    expect(res.status).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("anthropic_api still requires a key (regression test for the gate)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", ""));

    expect(res.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});
