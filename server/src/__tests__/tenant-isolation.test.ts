/**
 * Cross-tenant data isolation tests (Wave 16A).
 *
 * These are lightweight smoke tests that exercise the `assertCompanyAccess`
 * and `requireCompanyAccess` guards. They hit representative route files:
 * dashboard, goals, issues, agents, company memory, agent reviews,
 * and onboarding accept-decision. If a route is missing the guard, we
 * expect the request to short-circuit with 403 before any service call
 * runs.
 *
 * Strategy: mount each router onto a minimal express app, inject a
 * fake `req.actor` for user A (board, membership in companyA only), and
 * request a resource scoped to companyB. Result should be 403. If the
 * test ever returns 200, someone regressed the guard.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "user-a";
const AGENT_IN_B = "33333333-3333-4333-8333-333333333333";

type Actor = Record<string, unknown>;

function boardActorForA(): Actor {
  return {
    type: "board",
    userId: USER_A,
    companyIds: [COMPANY_A],
    isInstanceAdmin: false,
    source: "session",
  };
}

/** Board actor with no memberships at all (but not an instance admin). */
function boardActorWithNoCompanies(): Actor {
  return {
    type: "board",
    userId: "user-no-memberships",
    companyIds: [],
    isInstanceAdmin: false,
    source: "session",
  };
}

function buildApp(actor: Actor, mount: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Actor }).actor = actor;
    next();
  });
  mount(app);
  app.use(errorHandler);
  return app;
}

// ─── Shared service mocks ──────────────────────────────────────────────────
// All service calls are spied; if any leak bypasses the guard, we'll see
// these invoked with the foreign companyId and the assertion will fail.

const spy = {
  dashboardSummary: vi.fn().mockResolvedValue({}),
  goalsList: vi.fn().mockResolvedValue([]),
  goalsCreate: vi.fn(),
  issuesList: vi.fn().mockResolvedValue([]),
  memoryList: vi.fn().mockResolvedValue([]),
  memoryCreate: vi.fn(),
  skillsList: vi.fn().mockResolvedValue([]),
  agentsList: vi.fn().mockResolvedValue([]),
  agentsGetById: vi.fn().mockResolvedValue({
    id: AGENT_IN_B,
    companyId: COMPANY_B,
    name: "Builder-in-B",
  }),
  agentReviewsGetLatest: vi.fn().mockResolvedValue(null),
  agentReviewsGenerate: vi.fn(),
  agentReviewsCreateManual: vi.fn(),
  integrationsList: vi.fn().mockResolvedValue([]),
  issueCreate: vi.fn(),
  logActivity: vi.fn(),
};

// dashboard.ts imports the service directly from ../services/dashboard.js,
// not via the barrel. Mock that path too.
vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => ({ summary: spy.dashboardSummary }),
}));

vi.mock("../services/index.js", () => ({
  dashboardService: () => ({ summary: spy.dashboardSummary }),
  goalService: () => ({
    list: spy.goalsList,
    create: spy.goalsCreate,
    getById: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  issueService: () => ({
    list: spy.issuesList,
    getById: vi.fn(),
    getByIdentifier: vi.fn(),
    create: spy.issueCreate,
    listLabels: vi.fn(),
    createLabel: vi.fn(),
    listAttachments: vi.fn(),
  }),
  companyMemoryService: () => ({
    list: spy.memoryList,
    create: spy.memoryCreate,
    update: vi.fn(),
    remove: vi.fn(),
    generateWeeklySummary: vi.fn(),
  }),
  companySkillService: () => ({
    list: spy.skillsList,
    detail: vi.fn(),
    readFile: vi.fn(),
    updateStatus: vi.fn(),
    createLocalSkill: vi.fn(),
    updateFile: vi.fn(),
    importFromSource: vi.fn(),
    scanProjectWorkspaces: vi.fn(),
    deleteSkill: vi.fn(),
    installUpdate: vi.fn(),
  }),
  agentService: () => ({
    list: spy.agentsList,
    getById: spy.agentsGetById,
    create: vi.fn(),
  }),
  agentReviewsService: () => ({
    list: vi.fn().mockResolvedValue([]),
    getLatest: spy.agentReviewsGetLatest,
    generateMonthlyReview: spy.agentReviewsGenerate,
    createManual: spy.agentReviewsCreateManual,
  }),
  integrationService: () => ({
    list: spy.integrationsList,
    create: vi.fn(),
    remove: vi.fn(),
    getByKind: vi.fn(),
    getDecryptedApiKey: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn().mockResolvedValue(true),
    hasPermission: vi.fn().mockResolvedValue(true),
    ensureMembership: vi.fn(),
    listPrincipalGrants: vi.fn().mockResolvedValue([]),
    setPrincipalPermission: vi.fn(),
  }),
  // Onboarding route dependencies — stubbed because the accept-decision
  // handler short-circuits on the guard before touching these.
  companyService: () => ({ getById: vi.fn(), create: vi.fn() }),
  secretService: () => ({
    create: vi.fn(),
    normalizeEnvBindingsForPersistence: vi.fn(),
    normalizeHireApprovalPayloadForPersistence: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  projectService: () => ({ create: vi.fn() }),
  // Issues route dependencies
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({}),
  heartbeatService: () => ({}),
  instanceSettingsService: () => ({}),
  issueApprovalService: () => ({}),
  documentService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
  // Utility mocks
  logActivity: spy.logActivity,
  validateAnthropicKey: vi.fn().mockResolvedValue({ valid: true }),
  deliverMorningBriefToSlack: vi.fn(),
}));

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("tenant isolation (Wave 16A)", () => {
  beforeEach(() => {
    for (const fn of Object.values(spy)) fn.mockClear();
  });

  it("dashboard: user A cannot fetch company B's dashboard", async () => {
    const { dashboardRoutes } = await import("../routes/dashboard.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", dashboardRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/dashboard`);

    expect(res.status).toBe(403);
    expect(spy.dashboardSummary).not.toHaveBeenCalled();
  });

  it("goals: user A cannot list goals for company B", async () => {
    const { goalRoutes } = await import("../routes/goals.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", goalRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/goals`);

    expect(res.status).toBe(403);
    expect(spy.goalsList).not.toHaveBeenCalled();
  });

  it("issues: user A cannot list issues for company B", async () => {
    const { issueRoutes } = await import("../routes/issues.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", issueRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/issues`);

    expect(res.status).toBe(403);
    expect(spy.issuesList).not.toHaveBeenCalled();
  });

  it("company memory: user A cannot list entries for company B", async () => {
    const { companyMemoryRoutes } = await import("../routes/company-memory.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", companyMemoryRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/memory`);

    expect(res.status).toBe(403);
    expect(spy.memoryList).not.toHaveBeenCalled();
  });

  it("company memory: user A cannot write a memory entry in company B", async () => {
    const { companyMemoryRoutes } = await import("../routes/company-memory.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", companyMemoryRoutes({} as unknown as never)));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_B}/memory`)
      .send({ title: "leaky", body: "should not write", kind: "founder_note" });

    expect(res.status).toBe(403);
    expect(spy.memoryCreate).not.toHaveBeenCalled();
  });

  it("company skills: user A cannot list skills for company B", async () => {
    const { companySkillRoutes } = await import("../routes/company-skills.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", companySkillRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/skills`);

    expect(res.status).toBe(403);
    expect(spy.skillsList).not.toHaveBeenCalled();
  });

  it("agent-reviews: user A cannot read reviews for an agent whose company they don't own", async () => {
    const { agentReviewRoutes } = await import("../routes/agent-reviews.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", agentReviewRoutes({} as unknown as never)));

    const res = await request(app).get(
      `/api/companies/${COMPANY_B}/agents/${AGENT_IN_B}/reviews/latest`,
    );

    expect(res.status).toBe(403);
    expect(spy.agentReviewsGetLatest).not.toHaveBeenCalled();
  });

  it("agent-reviews: route company/agent mismatch is rejected even within a company the user can access", async () => {
    // User A has access to companyA. Pass an agentId that actually lives in
    // companyB. The route must refuse — prior regression allowed this.
    const { agentReviewRoutes } = await import("../routes/agent-reviews.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", agentReviewRoutes({} as unknown as never)));

    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/agents/${AGENT_IN_B}/reviews/latest`,
    );

    expect([403, 404]).toContain(res.status);
    expect(spy.agentReviewsGetLatest).not.toHaveBeenCalled();
  });

  it("integrations: user A cannot list integrations for company B", async () => {
    const { integrationRoutes } = await import("../routes/integrations.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", integrationRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_B}/integrations`);

    expect(res.status).toBe(403);
    expect(spy.integrationsList).not.toHaveBeenCalled();
  });

  it("onboarding: user A cannot accept a decision targeting company B (body.companyId)", async () => {
    const { onboardingRoutes } = await import("../routes/onboarding.js");
    const app = buildApp(boardActorForA(), (a) => a.use("/api", onboardingRoutes({} as unknown as never)));

    const res = await request(app)
      .post("/api/onboarding/accept-decision")
      .send({
        companyId: COMPANY_B,
        decision: {
          id: "dec-1",
          slot: "cos",
          title: "Do thing",
          rationale: "Because.",
        },
        agentIdsBySlot: {
          cos: "44444444-4444-4444-8444-444444444444",
          growth: "55555555-5555-4555-8555-555555555555",
          content: "66666666-6666-4666-8666-666666666666",
          finance: "77777777-7777-4777-8777-777777777777",
        },
        projectId: "88888888-8888-4888-8888-888888888888",
      });

    expect(res.status).toBe(403);
    expect(spy.issueCreate).not.toHaveBeenCalled();
  });

  it("board actor with zero memberships cannot access any company", async () => {
    const { dashboardRoutes } = await import("../routes/dashboard.js");
    const app = buildApp(boardActorWithNoCompanies(), (a) =>
      a.use("/api", dashboardRoutes({} as unknown as never)),
    );

    const res = await request(app).get(`/api/companies/${COMPANY_A}/dashboard`);

    expect(res.status).toBe(403);
    expect(spy.dashboardSummary).not.toHaveBeenCalled();
  });

  it("instance admin bypasses company membership check", async () => {
    const admin: Actor = {
      type: "board",
      userId: "admin",
      companyIds: [],
      isInstanceAdmin: true,
      source: "session",
    };
    const { dashboardRoutes } = await import("../routes/dashboard.js");
    const app = buildApp(admin, (a) => a.use("/api", dashboardRoutes({} as unknown as never)));

    const res = await request(app).get(`/api/companies/${COMPANY_A}/dashboard`);

    expect(res.status).toBe(200);
    expect(spy.dashboardSummary).toHaveBeenCalledWith(COMPANY_A);
  });
});
