/**
 * Council 2026-05-05 P2 (TC-2) — analytics integration is a hard milestone
 * for paid users on the bootstrap route. Free / trial users skip the gate.
 *
 * The check sits between the Anthropic-key validation and the bootstrap
 * orchestrator call, so a paid user with no analytics intent is rejected
 * BEFORE any company / membership / agents row is written. That keeps the
 * trust contract of "we never show mock data on a paid surface" intact at
 * the data-layer level — without a connected (or at least committed-to)
 * analytics integration, the GrowthConsole has nothing real to render and
 * we'd otherwise have leaked mock data on the dashboard.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Service mocks — same shape as onboarding-adapter-type.test.ts. These tests
// exercise the route layer; the bootstrap orchestrator's persistence is
// covered separately by onboarding-bootstrap-atomicity.test.ts.
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

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  accessService: () => mockAccessService,
  secretService: () => mockSecretService,
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  companyMemoryService: () => mockMemoryService,
  instanceSettingsService: () => mockInstanceSettingsService,
  validateAnthropicKey: mockValidateAnthropicKey,
  logActivity: mockLogActivity,
}));

// Subscription service is the new dependency this test cares about. Hoisted
// `vi.fn()` so each `it` block can flip the return value to simulate paid /
// trial / billing-failure paths without re-mocking the module.
const mockIsSubscriptionActive = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);

vi.mock("../services/subscription.js", () => ({
  subscriptionService: () => ({
    isSubscriptionActive: mockIsSubscriptionActive,
  }),
}));

// Bootstrap orchestrator: fully mock so we don't depend on the real
// transaction running against a fake DB. The real orchestrator's behavior
// is covered by `onboarding-bootstrap-atomicity.test.ts` against an
// embedded Postgres. Here we only care that the route layer's milestone
// check (a) blocks BEFORE invoking the orchestrator on a paid+no-analytics
// payload, and (b) lets it through on the satisfying payloads.
const mockBootstrapCompanyOnboarding = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    companyId: "00000000-0000-0000-0000-000000000001",
    companyPrefix: "TEST",
    agentIdsBySlot: {
      cos: "agent-cos",
      growth: "agent-growth",
      content: "agent-content",
      finance: "agent-finance",
    },
    goalId: "goal-1",
    projectId: "project-1",
    firstRunPromise: Promise.resolve(null),
  }),
);

vi.mock("../services/onboarding-bootstrap.js", async () => {
  // Preserve the real exports for AGENT_SLOTS / ANALYTICS_INTEGRATION_KEYS;
  // override only the orchestrator. importActual returns the real module so
  // const-tuple exports stay intact.
  const actual = await vi.importActual<typeof import("../services/onboarding-bootstrap.js")>(
    "../services/onboarding-bootstrap.js",
  );
  return {
    ...actual,
    bootstrapCompanyOnboarding: mockBootstrapCompanyOnboarding,
  };
});

// ---------------------------------------------------------------------------
// Test app factory — mirrors onboarding-adapter-type.test.ts.
// ---------------------------------------------------------------------------

async function createApp() {
  const [{ onboardingRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/onboarding.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-user",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const fakeDb: Record<string, unknown> = {};
  fakeDb.transaction = async (cb: (tx: unknown) => unknown) => cb(fakeDb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", onboardingRoutes(fakeDb as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const charterSlot = (slot: string) => ({
  slot,
  name: `${slot} agent`,
  title: `${slot} title`,
  charter: "Do great work every day",
  firstPriority: "Start immediately",
});

function makePayload(integrations: Record<string, boolean> = {}) {
  return {
    vision:
      "We are building an AI-native startup management tool for founders who want to move fast.",
    bottlenecks: ["pmf"],
    team: "solo",
    adapterChoice: "claude_local",
    anthropicKey: "",
    integrations,
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

describe("onboarding bootstrap — analytics-integration milestone for paid users (TC-2)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
    // Default: subscription INACTIVE — milestone gate must NOT fire.
    mockIsSubscriptionActive.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("trial / free user — no integrations selected → bootstrap orchestrator is invoked (gate is paid-only)", async () => {
    mockIsSubscriptionActive.mockResolvedValue(false);
    const app = await createApp();
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload({}));

    expect(res.status).toBe(201);
    expect(mockBootstrapCompanyOnboarding).toHaveBeenCalledTimes(1);
  });

  it("paid user — no analytics integration selected → 422 ANALYTICS_INTEGRATION_REQUIRED, orchestrator never invoked", async () => {
    mockIsSubscriptionActive.mockResolvedValue(true);
    const app = await createApp();

    // No analytics flag set — should be rejected.
    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload({ slack: true, notion: true }));

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/analytics integration is required/i);
    expect(res.body.details).toMatchObject({
      code: "ANALYTICS_INTEGRATION_REQUIRED",
      acceptedKinds: expect.arrayContaining(["stripe", "posthog", "linkedin"]),
    });

    // CRITICAL: rejection must occur BEFORE the bootstrap orchestrator is
    // invoked. No DB writes happen for a rejected payload.
    expect(mockBootstrapCompanyOnboarding).not.toHaveBeenCalled();
  });

  it.each([
    ["stripe", { stripe: true }],
    ["posthog", { posthog: true }],
    ["linkedin", { linkedin: true }],
  ] as const)(
    "paid user — selecting %s satisfies the milestone and orchestrator runs",
    async (_label, integrations) => {
      mockIsSubscriptionActive.mockResolvedValue(true);
      const app = await createApp();

      const res = await request(app)
        .post("/api/onboarding/bootstrap")
        .send(makePayload(integrations));

      expect(res.status).toBe(201);
      expect(mockBootstrapCompanyOnboarding).toHaveBeenCalledTimes(1);
      // The orchestrator received the integrations flags as-passed. The
      // route layer does not transform them; the bootstrap input is the
      // founder's stated intent at sign-up time.
      const [, bootstrapInput] = mockBootstrapCompanyOnboarding.mock.calls[0];
      expect(bootstrapInput.integrations).toMatchObject(integrations);
    },
  );

  it("paid user — billing-status check throws → fail OPEN (treat as trial); onboarding proceeds", async () => {
    // Failure-mode: the subscription query crashes. The route should NOT
    // dead-end the founder on a billing-API outage; instead it logs and
    // proceeds as if the user were on a trial. The downstream UI gate in
    // GrowthConsole reads billing status independently and will refuse to
    // render mocks if the user IS in fact paid at dashboard time.
    mockIsSubscriptionActive.mockRejectedValue(new Error("DB unreachable"));
    const app = await createApp();

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload({}));

    expect(res.status).toBe(201);
    expect(mockBootstrapCompanyOnboarding).toHaveBeenCalledTimes(1);
  });

  it("paid user — selecting non-analytics flags only (slack, hubspot, notion) → still 422", async () => {
    // The milestone is narrow on purpose: analytics-only. Slack and Notion
    // are useful but don't populate the GrowthConsole's funnel / channels.
    mockIsSubscriptionActive.mockResolvedValue(true);
    const app = await createApp();

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(makePayload({ slack: true, hubspot: true, notion: true }));

    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("ANALYTICS_INTEGRATION_REQUIRED");
    expect(mockBootstrapCompanyOnboarding).not.toHaveBeenCalled();
  });

  it("paid user — explicit `false` flags don't satisfy the gate", async () => {
    // Boolean false != true. Defensive — the schema accepts both, the gate
    // treats only true as opt-in.
    mockIsSubscriptionActive.mockResolvedValue(true);
    const app = await createApp();

    const res = await request(app)
      .post("/api/onboarding/bootstrap")
      .send(
        makePayload({
          stripe: false,
          posthog: false,
          linkedin: false,
        }),
      );

    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("ANALYTICS_INTEGRATION_REQUIRED");
  });
});
