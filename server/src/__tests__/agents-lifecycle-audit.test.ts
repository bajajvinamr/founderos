/**
 * PR-6b — Agent lifecycle audit regression guard.
 *
 * Synthesis from the 2026-05-07 dream-state hardening run flagged a P1
 * gap: pause / resume / terminate / delete on `/agents/:id/*` had no
 * regression test pinning the activity_log audit row. The handlers DO
 * write `logActivity(...)` rows today (server/src/routes/agents.ts:
 * 2071/2092/2115/2136 for pause/resume/terminate/delete and 2045 for
 * PATCH), but no test asserts the call shape — meaning a future refactor
 * could silently strip the audit and only a council audit would catch it.
 *
 * This file pins the audit contract: every successful lifecycle mutation
 * MUST produce one activity_log row with:
 *   - companyId    = agent.companyId (tenant scope, NOT actor's company)
 *   - actorType    = "user"          (board human or local_implicit)
 *   - actorId      = userId ?? "board" (fallback for synthetic principals)
 *   - action       = "agent.<verb>"  (paused | resumed | terminated | deleted)
 *   - entityType   = "agent"
 *   - entityId     = agent.id
 *
 * Same TDD-as-regression-guard pattern as PR-11 (env-validation CHECKS
 * coverage): the production code is already correct, but without these
 * tests a silent removal during refactor is invisible until prod incident.
 *
 * Mock surface mirrors agents-self-patch-escalation.test.ts — same
 * `vi.hoisted(() => vi.fn())` pattern so the module mock can capture
 * `logActivity` from `../services/index.js`.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "44444444-4444-4444-8444-444444444444";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer" as const,
  permissionLevel: "approve" as const,
  title: "Builder",
  icon: null,
  status: "idle" as const,
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 1000,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
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

const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({ list: vi.fn() }));

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

const boardActorWithUserId = {
  type: "board",
  userId: "user-abc",
  isInstanceAdmin: true,
  companyIds: [companyId],
  source: "supabase",
};

const boardActorNoUserId = {
  type: "board",
  isInstanceAdmin: true,
  companyIds: [companyId],
  source: "local_implicit",
};

describe("PR-6b — agent lifecycle audit regression guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.pause.mockResolvedValue({
      ...baseAgent,
      status: "paused",
    });
    mockAgentService.resume.mockResolvedValue({
      ...baseAgent,
      status: "active",
    });
    mockAgentService.terminate.mockResolvedValue({
      ...baseAgent,
      status: "terminated",
    });
    mockAgentService.remove.mockResolvedValue(baseAgent);
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    // Create-path mock defaults — pause/resume/terminate/delete don't
    // touch these, but POST /companies/:companyId/agents does.
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {},
      lookups: [],
    });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: unknown) => agent,
    );
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
  });

  // -- pause --------------------------------------------------------

  describe("POST /agents/:id/pause", () => {
    it("writes activity_log row on success", async () => {
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/pause`);

      expect(res.status).toBe(200);
      expect(mockAgentService.pause).toHaveBeenCalledWith(agentId);
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(
        agentId,
      );
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.paused",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("does NOT write audit row when agent not found (404)", async () => {
      mockAgentService.pause.mockResolvedValue(null);
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/pause`);

      expect(res.status).toBe(404);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("falls back to actorId='board' when userId is absent (local_implicit)", async () => {
      const app = createApp(boardActorNoUserId);
      const res = await request(app).post(`/api/agents/${agentId}/pause`);

      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: "board",
          action: "agent.paused",
        }),
      );
    });

    it("audits with the AGENT's companyId, not the actor's", async () => {
      // Tenant-scope contract: even if the actor's company list doesn't
      // match, the audit row is keyed to the agent's tenant. (Instance
      // admin can pause cross-tenant; the audit must reflect WHICH tenant
      // the action affected, not the actor's primary tenant.)
      mockAgentService.pause.mockResolvedValue({
        ...baseAgent,
        companyId: otherCompanyId,
        status: "paused",
      });
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/pause`);

      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: otherCompanyId,
          action: "agent.paused",
        }),
      );
    });
  });

  // -- resume --------------------------------------------------------

  describe("POST /agents/:id/resume", () => {
    it("writes activity_log row on success", async () => {
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/resume`);

      expect(res.status).toBe(200);
      expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.resumed",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("does NOT write audit row when agent not found (404)", async () => {
      mockAgentService.resume.mockResolvedValue(null);
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/resume`);

      expect(res.status).toBe(404);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("does NOT cancel active runs on resume (only pause/terminate cancel)", async () => {
      // Resume's contract is: re-enable the agent. Active runs (if any
      // existed during the paused window) should not be killed by the
      // resume. cancelActiveForAgent is intentionally absent from this
      // handler — pinning that here so a refactor can't silently add it.
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/resume`);

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.cancelActiveForAgent).not.toHaveBeenCalled();
    });
  });

  // -- terminate -----------------------------------------------------

  describe("POST /agents/:id/terminate", () => {
    it("writes activity_log row on success and cancels active runs", async () => {
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/terminate`);

      expect(res.status).toBe(200);
      expect(mockAgentService.terminate).toHaveBeenCalledWith(agentId);
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(
        agentId,
      );
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.terminated",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("does NOT write audit row when agent not found (404)", async () => {
      mockAgentService.terminate.mockResolvedValue(null);
      const app = createApp(boardActorWithUserId);
      const res = await request(app).post(`/api/agents/${agentId}/terminate`);

      expect(res.status).toBe(404);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  // -- delete --------------------------------------------------------

  describe("DELETE /agents/:id", () => {
    it("writes activity_log row on success", async () => {
      const app = createApp(boardActorWithUserId);
      const res = await request(app).delete(`/api/agents/${agentId}`);

      expect(res.status).toBe(200);
      expect(mockAgentService.remove).toHaveBeenCalledWith(agentId);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.deleted",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("does NOT write audit row when agent not found (404)", async () => {
      mockAgentService.remove.mockResolvedValue(null);
      const app = createApp(boardActorWithUserId);
      const res = await request(app).delete(`/api/agents/${agentId}`);

      expect(res.status).toBe(404);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  // -- create --------------------------------------------------------
  //
  // The create route (POST /companies/:companyId/agents at agents.ts:1549)
  // emits one `agent.created` activity_log row at agents.ts:1594-1608. The
  // four lifecycle handlers above (pause/resume/terminate/delete) all
  // pin their own audit calls; create completes the lifecycle audit
  // surface. Without this pin, a refactor of the create handler that
  // strips logActivity (or moves it inside a side branch that doesn't
  // execute on the happy path) would silently break the founder's
  // ability to see "I hired this agent at <ts>" in their activity feed.

  describe("POST /companies/:companyId/agents", () => {
    it("writes activity_log row on success with action='agent.created'", async () => {
      const app = createApp(boardActorWithUserId);
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: "Builder", adapterType: "claude_local" });

      expect(res.status).toBe(201);
      expect(mockAgentService.create).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.created",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("audit row carries name + role in details (founder-visible context)", async () => {
      // The activity timeline UI surfaces these details to give the
      // founder a "I hired Builder (engineer)" hint without joining
      // back to the agents table — pinning the contract so a refactor
      // can't silently drop the details payload.
      const app = createApp(boardActorWithUserId);
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: "Builder", adapterType: "claude_local" });

      expect(res.status).toBe(201);
      const callArg = mockLogActivity.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg).toBeDefined();
      const details = callArg.details as Record<string, unknown>;
      expect(details).toMatchObject({
        name: "Builder",
        role: "engineer",
      });
    });

    it("falls back to actorId='board' when userId is absent (local_implicit)", async () => {
      const app = createApp(boardActorNoUserId);
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: "Builder", adapterType: "claude_local" });

      expect(res.status).toBe(201);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: "board",
          action: "agent.created",
        }),
      );
    });
  });

  // -- permissions ---------------------------------------------------
  //
  // PATCH /agents/:id/permissions at agents.ts:1636 emits one
  // `agent.permissions_updated` activity_log row at agents.ts:1676-1689.
  // This is a SECURITY-RELEVANT audit — privilege changes (canCreateAgents,
  // canAssignTasks) must always leave a tenant-scoped trail so a buyer
  // forensic review can answer "who escalated this agent's permissions
  // and when?". A refactor that reorders the access.setPrincipalPermission
  // → logActivity sequence and accidentally moves logActivity into a
  // conditional branch would silently break the audit and only a council
  // pass would catch it.

  describe("PATCH /agents/:id/permissions", () => {
    it("writes activity_log row on success with action='agent.permissions_updated'", async () => {
      mockAgentService.getById.mockResolvedValue(baseAgent);
      mockAgentService.updatePermissions.mockResolvedValue({
        ...baseAgent,
        permissions: { canCreateAgents: true },
      });
      mockAgentService.getChainOfCommand.mockResolvedValue([]);
      mockAccessService.getMembership.mockResolvedValue(null);
      mockAccessService.listPrincipalGrants.mockResolvedValue([]);

      const app = createApp(boardActorWithUserId);
      const res = await request(app)
        .patch(`/api/agents/${agentId}/permissions`)
        .send({ canCreateAgents: true, canAssignTasks: false });

      expect(res.status).toBe(200);
      expect(mockAgentService.updatePermissions).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorType: "user",
          actorId: "user-abc",
          action: "agent.permissions_updated",
          entityType: "agent",
          entityId: agentId,
        }),
      );
    });

    it("audit details carry canCreateAgents + canAssignTasks (privilege-change context)", async () => {
      // Buyer forensic surface: the audit details payload is what tells a
      // reviewer WHICH permission flipped. Without this, the row would
      // only say "permissions_updated" with no before/after — useless for
      // incident response. Pinning the contract so the details payload
      // can't silently shrink during a refactor.
      mockAgentService.getById.mockResolvedValue(baseAgent);
      mockAgentService.updatePermissions.mockResolvedValue({
        ...baseAgent,
        permissions: { canCreateAgents: true },
      });
      mockAgentService.getChainOfCommand.mockResolvedValue([]);
      mockAccessService.getMembership.mockResolvedValue(null);
      mockAccessService.listPrincipalGrants.mockResolvedValue([]);

      const app = createApp(boardActorWithUserId);
      const res = await request(app)
        .patch(`/api/agents/${agentId}/permissions`)
        .send({ canCreateAgents: true, canAssignTasks: false });

      expect(res.status).toBe(200);
      const callArg = mockLogActivity.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg).toBeDefined();
      const details = callArg.details as Record<string, unknown>;
      // effectiveCanAssignTasks = (role==='ceo') || canCreateAgents || req.body.canAssignTasks.
      // baseAgent.role='engineer'; canCreateAgents flipped to true → effective=true.
      expect(details).toMatchObject({
        canCreateAgents: true,
        canAssignTasks: true,
      });
    });

    it("falls back to actorId='board' when userId is absent (local_implicit)", async () => {
      mockAgentService.getById.mockResolvedValue(baseAgent);
      mockAgentService.updatePermissions.mockResolvedValue({
        ...baseAgent,
        permissions: { canCreateAgents: false },
      });
      mockAgentService.getChainOfCommand.mockResolvedValue([]);
      mockAccessService.getMembership.mockResolvedValue(null);
      mockAccessService.listPrincipalGrants.mockResolvedValue([]);

      const app = createApp(boardActorNoUserId);
      const res = await request(app)
        .patch(`/api/agents/${agentId}/permissions`)
        .send({ canCreateAgents: false, canAssignTasks: false });

      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: "board",
          action: "agent.permissions_updated",
        }),
      );
    });

    it("does NOT write audit row when agent not found (404)", async () => {
      mockAgentService.getById.mockResolvedValue(null);

      const app = createApp(boardActorWithUserId);
      const res = await request(app)
        .patch(`/api/agents/${agentId}/permissions`)
        .send({ canCreateAgents: true, canAssignTasks: true });

      expect(res.status).toBe(404);
      expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  // -- cross-handler invariants -------------------------------------

  describe("authz / actor-type guards", () => {
    it("agent-typed actor is 403'd before any audit runs (assertBoard)", async () => {
      // Agents must not be able to lifecycle-mutate other agents — only
      // board (founder/instance-admin) actors can. assertBoard fires
      // BEFORE the service call, so neither pause() nor logActivity()
      // should be reached.
      const agentActor = {
        type: "agent",
        agentId: "55555555-5555-4555-8555-555555555555",
        companyId,
        companyIds: [companyId],
      };
      const app = createApp(agentActor);
      const res = await request(app).post(`/api/agents/${agentId}/pause`);

      expect(res.status).toBe(403);
      expect(mockAgentService.pause).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("none-typed actor is 401'd before any audit runs", async () => {
      const app = createApp({ type: "none" });
      const res = await request(app).post(`/api/agents/${agentId}/terminate`);

      expect(res.status).toBe(401);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });
});
