import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  // Lifecycle audit pin additions (issue.created/deleted) — POST/DELETE
  // handlers don't share with the blocker/reviewer/approver tests.
  create: vi.fn(),
  remove: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => false),
    hasPermission: vi.fn(async () => false),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
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
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Activity event issue",
    executionPolicy: null,
    executionState: null,
  };
}

describe("issue activity event routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("logs blocker activity with added and removed issue summaries", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getRelationSummaries
      .mockResolvedValueOnce({
        blockedBy: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            identifier: "PAP-10",
            title: "Old blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [],
      })
      .mockResolvedValueOnce({
        blockedBy: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            identifier: "PAP-11",
            title: "New blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [],
      });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ blockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.blockers_updated",
        details: expect.objectContaining({
          addedBlockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
          removedBlockedByIssueIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
          addedBlockedByIssues: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              identifier: "PAP-11",
              title: "New blocker",
            },
          ],
          removedBlockedByIssues: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              identifier: "PAP-10",
              title: "Old blocker",
            },
          ],
        }),
      }),
    );
  }, 15_000);

  it("logs explicit reviewer and approver activity when execution policy participants change", async () => {
    const existingPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" }],
        },
      ],
    })!;
    const nextPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue(),
      executionPolicy: existingPolicy,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      executionPolicy: patch.executionPolicy,
      updatedAt: new Date(),
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ executionPolicy: nextPolicy });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.reviewers_updated",
        details: expect.objectContaining({
          participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
          addedParticipants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
          removedParticipants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555", userId: null }],
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.approvers_updated",
        details: expect.objectContaining({
          participants: [{ type: "user", agentId: null, userId: "local-board" }],
          addedParticipants: [{ type: "user", agentId: null, userId: "local-board" }],
          removedParticipants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa", userId: null }],
        }),
      }),
    );
  });

  // -- core lifecycle audit pins ------------------------------------
  //
  // The blocker/reviewer/approver tests above cover the *secondary*
  // audit emissions on PATCH /issues/:id (when the body includes the
  // relevant relation arrays). These three tests pin the *primary*
  // lifecycle audit calls — issue.created on POST, issue.updated on
  // PATCH (status change), issue.deleted on DELETE — that exist in
  // production at issues.ts:824 / 1082 / 1444. They were previously
  // unpinned: a refactor that strips one of these `logActivity(...)`
  // calls would silently break the founder's ability to see "I
  // created PAP-580" / "I closed PAP-580" / "I deleted PAP-580" in
  // the activity timeline.
  //
  // Same TDD-as-regression-guard pattern as PR-6b (agent lifecycle),
  // PR-72 (agent.created), PR-74 (approval decisions).

  describe("POST /companies/:companyId/issues", () => {
    it("emits issue.created with title + identifier in details", async () => {
      const created = {
        id: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        identifier: "PAP-999",
        title: "First task",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: null,
      };
      mockIssueService.create.mockResolvedValue(created);

      const res = await request(createApp())
        .post("/api/companies/company-1/issues")
        .send({ title: "First task" });

      expect(res.status).toBe(201);
      expect(mockIssueService.create).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "local-board",
          action: "issue.created",
          entityType: "issue",
          entityId: created.id,
          details: expect.objectContaining({
            title: "First task",
            identifier: "PAP-999",
          }),
        }),
      );
    });
  });

  describe("PATCH /issues/:id (status change)", () => {
    it("emits issue.updated with the status delta in details._previous", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      // Match the field-shape the production handler diffs over.
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(createApp())
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "in_progress" });

      expect(res.status).toBe(200);
      // Pin the primary audit call. The handler may emit other rows for
      // related side-effects (e.g., reopen-on-comment), but for a plain
      // status change there should be exactly one issue.updated audit.
      const updatedCalls = mockLogActivity.mock.calls.filter(
        (call) => (call[1] as { action?: string }).action === "issue.updated",
      );
      expect(updatedCalls).toHaveLength(1);
      const callArg = updatedCalls[0]?.[1] as Record<string, unknown>;
      expect(callArg).toMatchObject({
        companyId: "company-1",
        actorType: "user",
        actorId: "local-board",
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
      });
      const details = callArg.details as Record<string, unknown>;
      expect(details).toMatchObject({
        status: "in_progress",
        identifier: "PAP-580",
      });
    });
  });

  describe("DELETE /issues/:id", () => {
    it("emits issue.deleted with entity reference but no details payload required", async () => {
      const issue = makeIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.listAttachments.mockResolvedValue([]);
      mockIssueService.remove.mockResolvedValue(issue);

      const res = await request(createApp())
        .delete(`/api/issues/${issue.id}`);

      expect(res.status).toBe(200);
      expect(mockIssueService.remove).toHaveBeenCalledWith(issue.id);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "local-board",
          action: "issue.deleted",
          entityType: "issue",
          entityId: issue.id,
        }),
      );
    });

    it("does NOT emit when issue not found (404)", async () => {
      mockIssueService.getById.mockResolvedValue(null);

      const res = await request(createApp())
        .delete("/api/issues/00000000-0000-4000-8000-000000000000");

      expect(res.status).toBe(404);
      expect(mockIssueService.remove).not.toHaveBeenCalled();
      // No issue.deleted audit row — production code guards on getById.
      const deletedCalls = mockLogActivity.mock.calls.filter(
        (call) => (call[1] as { action?: string }).action === "issue.deleted",
      );
      expect(deletedCalls).toHaveLength(0);
    });
  });
});
