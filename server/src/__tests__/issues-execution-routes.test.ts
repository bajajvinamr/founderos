/**
 * Route-level tests for registerExecutionRoutes (issues-execution.ts):
 *   GET  /issues/:id/approvals
 *   POST /issues/:id/approvals
 *   DELETE /issues/:id/approvals/:approvalId
 *   POST /issues/:id/checkout
 *   POST /issues/:id/release
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listAttachments: vi.fn(),
  getRelations: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  archiveInbox: vi.fn(),
  unarchiveInbox: vi.fn(),
  addLabel: vi.fn(),
  createLabel: vi.fn(),
  listLabels: vi.fn(),
  deleteLabel: vi.fn(),
  getLabelById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  cancelRun: vi.fn(async () => undefined),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => mockApprovalService,
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => mockProjectService,
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMPANY_ID = "company-1";

const baseIssue = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  identifier: "TEST-1",
  title: "Test issue",
  description: null,
  status: "in_progress",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: AGENT_ID,
  assigneeUserId: null,
  executionWorkspaceId: null,
  createdByUserId: null,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  labels: [],
  labelIds: [],
};

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp(agentId = AGENT_ID, runId = RUN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: COMPANY_ID,
      source: "agent_key",
    };
    next();
  });
  app.use((req, _res, next) => {
    // Simulate X-Agent-Run-Id header
    (req as any).headers["x-agent-run-id"] = runId;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /issues/:id/approvals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createBoardApp())
      .get(`/api/issues/${ISSUE_ID}/approvals`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns approvals list for existing issue", async () => {
    const approval = { id: APPROVAL_ID, issueId: ISSUE_ID, approvalId: "ap-1" };
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockApprovalService.listApprovalsForIssue.mockResolvedValue([approval]);

    const res = await request(createBoardApp())
      .get(`/api/issues/${ISSUE_ID}/approvals`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([approval]);
    expect(mockApprovalService.listApprovalsForIssue).toHaveBeenCalledWith(ISSUE_ID);
  });

  it("rejects cross-company access for non-local board actor", async () => {
    // local_implicit source bypasses company isolation (dev mode) — use session source instead
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-board",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use(errorHandler);

    mockIssueService.getById.mockResolvedValue({ ...baseIssue, companyId: "other-company" });
    const res = await request(app)
      .get(`/api/issues/${ISSUE_ID}/approvals`);
    expect(res.status).toBe(403);
  });
});

describe("POST /issues/:id/approvals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/approvals`)
      .send({ approvalId: APPROVAL_ID });
    expect(res.status).toBe(404);
  });

  it("links approval and returns 201 with updated list", async () => {
    const linked = { id: "link-1", issueId: ISSUE_ID, approvalId: APPROVAL_ID };
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockApprovalService.link.mockResolvedValue(linked);
    mockApprovalService.listApprovalsForIssue.mockResolvedValue([linked]);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/approvals`)
      .send({ approvalId: APPROVAL_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual([linked]);
    expect(mockApprovalService.link).toHaveBeenCalledWith(
      ISSUE_ID,
      APPROVAL_ID,
      expect.objectContaining({ userId: "user-board" }),
    );
  });

  it("rejects missing approvalId with 400", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/approvals`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /issues/:id/approvals/:approvalId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createBoardApp())
      .delete(`/api/issues/${ISSUE_ID}/approvals/${APPROVAL_ID}`);
    expect(res.status).toBe(404);
  });

  it("unlinks approval and returns ok:true", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockApprovalService.unlink.mockResolvedValue(undefined);

    const res = await request(createBoardApp())
      .delete(`/api/issues/${ISSUE_ID}/approvals/${APPROVAL_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockApprovalService.unlink).toHaveBeenCalledWith(ISSUE_ID, APPROVAL_ID);
  });
});

describe("POST /issues/:id/checkout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });
    expect(res.status).toBe(404);
  });

  it("returns 409 when project is paused due to budget", async () => {
    const issueWithProject = { ...baseIssue, projectId: "proj-1" };
    mockIssueService.getById.mockResolvedValue(issueWithProject);
    mockProjectService.getById.mockResolvedValue({
      id: "proj-1",
      pausedAt: new Date("2026-01-01"),
      pauseReason: "budget",
    });
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/budget/i);
  });

  it("checks out issue and returns updated issue (board actor)", async () => {
    const checkedOut = { ...baseIssue, status: "in_progress" };
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.checkout.mockResolvedValue(checkedOut);
    mockProjectService.getById.mockResolvedValue(null);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ISSUE_ID);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      ISSUE_ID,
      AGENT_ID,
      ["todo", "in_progress"],
      null,
    );
  });

  it("rejects missing agentId with 400", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/checkout`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /issues/:id/release", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`);
    expect(res.status).toBe(404);
  });

  it("releases issue as board user and returns updated issue", async () => {
    const released = { ...baseIssue, status: "todo", assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.release.mockResolvedValue(released);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("todo");
    expect(mockIssueService.release).toHaveBeenCalledWith(
      ISSUE_ID,
      undefined,
      null,
    );
  });

  it("returns 404 when release returns null (issue not found mid-flight)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.release.mockResolvedValue(null);

    const res = await request(createBoardApp())
      .post(`/api/issues/${ISSUE_ID}/release`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
