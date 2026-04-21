import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Aria",
  urlKey: "aria",
  role: "engineer",
  title: "Product Engineer",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: { promptTemplate: "You are Aria." },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissionLevel: "approve",
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  appendInstructionNote: vi.fn(),
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
const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
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
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
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
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as never));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-123",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [companyId],
};

describe("POST /api/companies/:companyId/agents/:agentId/founder-notes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_: string, config: unknown) => config,
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(
      async (_: string, config: unknown) => ({ config }),
    );
  });

  it("appends a founder note and increments notesCount", async () => {
    const existingTemplate = "You are Aria.";
    const agentWithTemplate = {
      ...baseAgent,
      adapterConfig: { promptTemplate: existingTemplate },
    };
    const note = "Skip Q4 plan. Focus only on Acme onboarding this week.";
    const updatedTemplate = `${existingTemplate}\n<founder_note added="2026-04-19T00:00:00.000Z">\n${note}\n</founder_note>`;
    const updatedAgent = {
      ...agentWithTemplate,
      adapterConfig: { promptTemplate: updatedTemplate },
      updatedAt: new Date("2026-04-19T00:00:00.000Z"),
    };

    mockAgentService.getById.mockResolvedValue(agentWithTemplate);
    mockAgentService.appendInstructionNote.mockResolvedValue(updatedAgent);

    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, notesCount: 1 });
    expect(mockAgentService.appendInstructionNote).toHaveBeenCalledWith(agentId, note);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.founder_note_added",
        entityType: "agent",
        entityId: agentId,
      }),
    );
  });

  it("accumulates multiple notes — notesCount grows", async () => {
    const twoNotesTemplate =
      "Base prompt.\n<founder_note added=\"2026-04-01T00:00:00.000Z\">\nFirst note.\n</founder_note>\n<founder_note added=\"2026-04-19T00:00:00.000Z\">\nSecond note.\n</founder_note>";
    const agentWithTwo = {
      ...baseAgent,
      adapterConfig: { promptTemplate: twoNotesTemplate },
      updatedAt: new Date("2026-04-19T00:00:00.000Z"),
    };

    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.appendInstructionNote.mockResolvedValue(agentWithTwo);

    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note: "Second note." });

    expect(res.status).toBe(200);
    expect(res.body.notesCount).toBe(2);
  });

  it("returns 400 when note is empty", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note: "" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when note exceeds 2000 chars", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note: "x".repeat(2001) });

    expect(res.status).toBe(400);
  });

  it("returns 404 when agent is not found", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note: "A note." });

    expect(res.status).toBe(404);
  });

  it("returns 404 when agent belongs to a different company", async () => {
    const alienAgent = { ...baseAgent, companyId: "different-company-id" };
    mockAgentService.getById.mockResolvedValue(alienAgent);
    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/founder-notes`)
      .send({ note: "A note." });

    expect(res.status).toBe(404);
  });
});
