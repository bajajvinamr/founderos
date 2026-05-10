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

// S8 P0.1 Phase 1D — onboarding route now mirrors the validated Anthropic
// key into the instance keystore so the server-side claude_local handler
// (Phase 1C) can read it via getDecryptedKey('anthropic', 'api'). Mocked
// here so the route can resolve the dynamic import without a real DB.
const mockInstanceApiKeysSetKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    family: "anthropic",
    executionMode: "api",
    keyHint: "…7890",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
);
vi.mock("../services/instance-api-keys.js", () => ({
  instanceApiKeysService: () => ({
    setKey: mockInstanceApiKeysSetKey,
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
// QW1 — BYO runner flag: preserves provider choice, marks transport
//
// FOUNDEROS_BYO_RUNNER_ENABLED=1 must NOT collapse adapterChoice to
// "byo_runner". The runner needs the concrete adapter type (codex_local,
// gemini_local, claude_local, etc.) to dispatch to the right CLI at claim
// time. Instead, adapter_config gains transport: "local_runner" as the signal.
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — BYO runner preserves provider choice (QW1 multi-provider)", () => {
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

  it("adapterChoice=codex_local + BYO flag → adapter_type=codex_local, NOT byo_runner", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("codex_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "codex_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      // transport: "local_runner" is set so the runner claims the job.
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("adapterChoice=gemini_local + BYO flag → adapter_type=gemini_local, NOT byo_runner", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("gemini_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "gemini_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("adapterChoice=claude_local + BYO flag → adapter_type=claude_local (regression baseline)", async () => {
    // claude_local is the baseline: it should still be preserved (not
    // collapsed to byo_runner) and gets transport: "local_runner" too.
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "claude_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("adapterChoice=anthropic_api + BYO flag → adapter_type=claude_local (key still stored as secret)", async () => {
    // anthropic_api collapses to claude_local via mapOnboardingChoiceToAdapter —
    // the Anthropic key is still stored as a company secret upstream.
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
      // anthropic_api → claude_local (mapOnboardingChoiceToAdapter) with transport
      expect(payload).toMatchObject({ adapterType: "claude_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("adapterChoice=skip + BYO flag → adapter_type=claude_local (skip defers to claude_local)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("skip"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "claude_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("BYO flag OFF → no transport in adapterConfig (flag-off baseline)", async () => {
    // Restore the BYO flag to OFF for this test only.
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("codex_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "codex_local" });
      // No transport key when BYO is off — adapterConfig only has env.
      expect(payload.adapterConfig).not.toHaveProperty("transport");
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

// ---------------------------------------------------------------------------
// S7.0.2 — 6-tile MVP additions: openai_api, google_api + auth_mode gate
//
// These cover the new `auth_mode === 'api'` path. The Zod schema accepts
// both new values; the bootstrap route enforces a non-empty key check
// for every `auth_mode === 'api'` choice. Live API validation is only
// wired for `anthropic_api` today (OpenAI/Google validators land with
// the respective S7.B tiles), so the OpenAI/Google paths assert the
// shape-level gate, not the live validation.
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — 6-tile MVP api adapters (S7.0.2)", () => {
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

  it("accepts adapterChoice=openai_api when key is provided (no anthropic validator fires)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("openai_api", "sk-openai-test-key-1234567890"));

    expect(res.status).toBe(201);
    // The OpenAI key path bypasses the Anthropic live validator —
    // wiring lands with the S7.B OpenAI tile.
    expect(mockValidateAnthropicKey).not.toHaveBeenCalled();
  });

  it("rejects adapterChoice=openai_api when key is missing (auth_mode='api' gate)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("openai_api", ""));

    expect(res.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects adapterChoice=google_api with 500 (S8 P0.1 — throw surfaces)", async () => {
    // S8 P0.1 Phase 1D — the bootstrap dev/local path now routes through
    // mapOnboardingChoiceToAdapter (PR #148), which throws "google_api
    // adapter is not yet implemented (S7 Phase 4)" instead of silently
    // collapsing to claude_local. The Zod schema still accepts the
    // choice + the key gate still enforces a non-empty key (asserted
    // in the sibling test below). Live wiring lands with the S7.B
    // Google API tile.
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("google_api", "AIza-google-test-key-1234567890"));

    expect(res.status).toBe(500);
    expect(mockValidateAnthropicKey).not.toHaveBeenCalled();
    // No agent rows persisted on the throw.
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects adapterChoice=google_api when key is missing (auth_mode='api' gate)", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("google_api", ""));

    expect(res.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary string outside the enum with 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("totally_made_up_provider", "irrelevant"));

    expect(res.status).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S8 P0.1 Phase 1D — hosted-mode tri-branch adapter resolution
//
// FOUNDEROS_HOSTED_AGENTS_ENABLED=1 takes precedence over BYO_RUNNER for
// the anthropic_api choice — the cloud runs server-side execution off the
// founder's pasted key, no laptop runner. Both flags off falls through to
// `mapOnboardingChoiceToAdapter` (the PR #148 dev/local path).
// ---------------------------------------------------------------------------

describe("onboarding bootstrap — hosted-aware adapter resolution (S8 P0.1)", () => {
  let savedHosted: string | undefined;
  let savedByo: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedHosted = process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    savedByo = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    delete process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  });

  afterEach(() => {
    if (savedHosted === undefined) delete process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    else process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = savedHosted;
    if (savedByo === undefined) delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    else process.env.FOUNDEROS_BYO_RUNNER_ENABLED = savedByo;
  });

  it("hosted=ON + anthropic_api → adapter_type=claude_local (server-side path)", async () => {
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    expect(calls.length).toBe(4);
    for (const [, payload] of calls) {
      // Hosted mode routes anthropic_api to claude_local — the server-side
      // handler reads the key from instance_api_keys (written by the route
      // post-validation) and dispatches via the Anthropic SDK in-process.
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
    // The route ALSO writes the validated key into the instance keystore
    // — Phase 1C handler reads from there.
    expect(mockInstanceApiKeysSetKey).toHaveBeenCalledTimes(1);
    expect(mockInstanceApiKeysSetKey).toHaveBeenCalledWith({
      family: "anthropic",
      executionMode: "api",
      value: "sk-ant-test-key-1234567890",
    });
  });

  it("hosted=ON dominates BYO=ON for anthropic_api (precedence test)", async () => {
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      // Hosted wins — anthropic_api goes to server-side claude_local even
      // though BYO is also enabled.
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
  });

  it("hosted=OFF + BYO=ON → adapter_type=claude_local with transport:local_runner (QW1 fix)", async () => {
    // QW1 multi-provider fix: BYO flag preserves the provider choice instead
    // of collapsing to byo_runner. anthropic_api → claude_local via
    // mapOnboardingChoiceToAdapter, and transport: "local_runner" is set.
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      // BYO path now preserves the provider (claude_local for anthropic_api).
      expect(payload).toMatchObject({ adapterType: "claude_local" });
      expect(payload.adapterType).not.toBe("byo_runner");
      expect(payload.adapterConfig).toMatchObject({ transport: "local_runner" });
    }
  });

  it("hosted=ON + claude_local choice → falls through to mapOnboardingChoiceToAdapter", async () => {
    // Hosted-mode short-circuit ONLY fires for adapterChoice=anthropic_api.
    // A founder who picks the CLI tile (claude_local) on a hosted instance
    // still gets claude_local mapping via the dev/local path — same end
    // result for this choice but exercises the third branch deliberately.
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
    // No instance-api-keys write — no key was provided / validated.
    expect(mockInstanceApiKeysSetKey).not.toHaveBeenCalled();
  });

  it("both flags OFF + anthropic_api → mapOnboardingChoiceToAdapter path (claude_local)", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    const calls = mockAgentService.create.mock.calls;
    for (const [, payload] of calls) {
      // Pre-PR-148 dev/local path collapses anthropic_api → claude_local.
      expect(payload).toMatchObject({ adapterType: "claude_local" });
    }
  });
});

// ---------------------------------------------------------------------------
// S8 P0.1 Phase 1D — onboarding route writes validated key into
// instance_api_keys (the Phase 1C handler reads from there).
// ---------------------------------------------------------------------------

describe("onboarding route — instance_api_keys vault write (S8 P0.1)", () => {
  let savedHosted: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedHosted = process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    delete process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  });

  afterEach(() => {
    if (savedHosted === undefined) delete process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    else process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = savedHosted;
  });

  it("writes the validated Anthropic key into instance_api_keys", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({ valid: true });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-test-key-1234567890"));

    expect(res.status).toBe(201);
    expect(mockInstanceApiKeysSetKey).toHaveBeenCalledTimes(1);
    expect(mockInstanceApiKeysSetKey).toHaveBeenCalledWith({
      family: "anthropic",
      executionMode: "api",
      value: "sk-ant-test-key-1234567890",
    });
  });

  it("does NOT write to instance_api_keys when key validation fails", async () => {
    const app = await createApp();
    mockValidateAnthropicKey.mockResolvedValue({
      valid: false,
      reason: "invalid_key",
    });

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("anthropic_api", "sk-ant-bad-key-1234567890"));

    expect(res.status).toBe(422);
    // Validation runs first; vault write is skipped on rejection.
    expect(mockInstanceApiKeysSetKey).not.toHaveBeenCalled();
    // Bootstrap also did not run — no agent rows.
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("does NOT write to instance_api_keys for non-anthropic_api adapter choices", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("claude_local"));

    expect(res.status).toBe(201);
    // claude_local choice never triggers the validate→store path.
    expect(mockInstanceApiKeysSetKey).not.toHaveBeenCalled();
  });

  it("does NOT write to instance_api_keys when adapterChoice=skip", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload("skip"));

    expect(res.status).toBe(201);
    expect(mockInstanceApiKeysSetKey).not.toHaveBeenCalled();
  });
});
