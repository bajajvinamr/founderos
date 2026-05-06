/**
 * P0 — Agent self-PATCH escalation regression tests.
 *
 * Threat model: an authenticated agent calling `PATCH /agents/<self>` must
 * not be able to escalate its own role, un-pause itself, raise its own
 * budget, or zero out its own spend counter. The synthesis from the
 * 2026-05-07 dream-state hardening run (`.qa/synthesis.md` P0-1) found
 * that:
 *   1. `assertCanUpdateAgent` short-circuits with `if (actor.id === target.id) return;`
 *      (server/src/routes/agents.ts:364)
 *   2. `updateAgentSchema` accepts `role`, `status`, `budgetMonthlyCents`,
 *      `spentMonthlyCents`, `reportsTo`, `permissionLevel`
 *      (packages/shared/src/validators/agent.ts:74-83)
 *
 * Combined: an agent could PATCH itself with `{role: "ceo"}` → unlock
 * the `actorAgent.role === "ceo"` blanket grant at agents.ts:365 and
 * mutate every other agent in the company.
 *
 * These tests pin the fix: self-PATCH on privileged fields must 403,
 * regardless of CEO role status. Self-PATCH on safe fields stays 200.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const siblingAgentId = "33333333-3333-4333-8333-333333333333";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer" as const,
  permissionLevel: "approve" as const,
  title: "Builder",
  icon: null,
  status: "paused" as const, // paused — un-pausing self is the threat
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 1000,
  spentMonthlyCents: 999,
  pauseReason: "policy",
  pausedAt: new Date("2026-05-01T00:00:00.000Z"),
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const siblingAgent = {
  ...baseAgent,
  id: siblingAgentId,
  name: "Sibling",
  urlKey: "sibling",
  role: "engineer" as const,
  status: "idle" as const,
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@founderos/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "FounderOS",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("PR-1 P0 — agent self-PATCH escalation guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockResolvedValue({ ...baseAgent, name: "Updated" });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId, config) => config,
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  // -- ATTACK CHAIN PINS ---------------------------------------------

  it("rejects self-PATCH that escalates role to ceo", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ role: "ceo" });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects self-PATCH that flips status from paused to active", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ status: "active" });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects self-PATCH that raises budgetMonthlyCents", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ budgetMonthlyCents: 999_999_999 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects self-PATCH that resets spentMonthlyCents to zero", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ spentMonthlyCents: 0 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects self-PATCH that changes reportsTo (org-chart manipulation)", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ reportsTo: siblingAgentId });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects self-PATCH that raises permissionLevel", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ permissionLevel: "autonomous" });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // -- BENIGN SELF-EDIT STAYS ALLOWED -------------------------------

  it("allows self-PATCH of safe display field (title)", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Senior Builder" });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
  });

  // -- BLENDED PAYLOAD: REJECT IF ANY PRIVILEGED FIELD PRESENT ------

  it("rejects self-PATCH that mixes a safe field with a privileged one", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Senior Builder", role: "ceo" });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // -- BOARD-AS-FOUNDER UNAFFECTED -----------------------------------

  it("allows board (founder) PATCH on agent with role and status fields", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ role: "ceo", status: "active" });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
  });

  // -- AGENT MUTATING SIBLING WITH PRIVILEGED FIELD UNAFFECTED ------
  // This pin documents that the self-PATCH guard is exclusively about
  // SELF-mutation. Sibling-mutation by an agent with permission still
  // routes through assertCanUpdateAgent's existing CEO/grant checks.
  // Adjusting that grant is out-of-scope for PR-1 (separate finding).

  it("allows agent with role=ceo to PATCH a sibling's role", async () => {
    const ceoAgent = { ...baseAgent, role: "ceo" as const };
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === agentId ? ceoAgent : siblingAgent,
    );
    mockAgentService.update.mockResolvedValue({ ...siblingAgent, role: "engineer" });

    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
    });
    const res = await request(app)
      .patch(`/api/agents/${siblingAgentId}`)
      .send({ role: "engineer" });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
  });
});
