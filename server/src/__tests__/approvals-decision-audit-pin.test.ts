import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Founder decision audit-trail regression guard.
//
// `server/src/routes/approvals.ts` emits three founder-decision audit
// rows on the happy paths:
//   - approval.approved          (approvals.ts:152-164)
//   - approval.rejected          (approvals.ts:300-310)
//   - approval.revision_requested (approvals.ts:330-340)
//
// `approval-routes-idempotency.test.ts` covers the *negative* invariant
// (no duplicate logs on already-resolved approvals) and the cross-tenant
// access guard, but never positively pins the audit row shape on the
// actual decision transition. A refactor that strips one of those three
// `logActivity(...)` calls would silently break the founder's
// audit-trail surface — exactly the buyer-handover risk that PR-6b
// pinned for the agent lifecycle handlers.
//
// Same TDD-as-regression-guard pattern: production code is correct
// today; the test exists so a refactor can't silently regress it.

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

async function createBoardApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ approvalRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/approvals.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("founder approval decision audit-trail pins", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  // -- approve -------------------------------------------------------

  describe("POST /approvals/:id/approve", () => {
    it("emits approval.approved with founder identity + approval scope", async () => {
      // Pre-existing approval in pending state (so requireApprovalAccess
      // can resolve company scope), then approve() returns applied=true
      // — only the applied=true branch emits the audit row.
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
        // No requestedByAgentId so we skip the wake-up + nested audit
        // emissions. We are pinning the PRIMARY decision audit only.
        requestedByAgentId: null,
      });
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "approval-1",
          companyId: "company-1",
          type: "hire_agent",
          status: "approved",
          payload: {},
          requestedByAgentId: null,
        },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-1/approve")
        .send({});

      expect(res.status).toBe(200);
      // Only the primary decision audit fires when there's no requester
      // agent (no wakeup → no requester_wakeup_queued).
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "user-1",
          action: "approval.approved",
          entityType: "approval",
          entityId: "approval-1",
        }),
      );
    });

    it("falls back to actorId='board' when board actor has no userId (local_implicit)", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
        requestedByAgentId: null,
      });
      mockApprovalService.approve.mockResolvedValue({
        approval: {
          id: "approval-1",
          companyId: "company-1",
          type: "hire_agent",
          status: "approved",
          payload: {},
          requestedByAgentId: null,
        },
        applied: true,
      });

      const app = await createBoardApp({ userId: undefined });
      const res = await request(app)
        .post("/api/approvals/approval-1/approve")
        .send({});

      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: "board",
          action: "approval.approved",
        }),
      );
    });
  });

  // -- reject --------------------------------------------------------

  describe("POST /approvals/:id/reject", () => {
    it("emits approval.rejected with founder identity + approval scope", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-2",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
      });
      mockApprovalService.reject.mockResolvedValue({
        approval: {
          id: "approval-2",
          companyId: "company-1",
          type: "hire_agent",
          status: "rejected",
          payload: {},
        },
        applied: true,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-2/reject")
        .send({ decisionNote: "not now" });

      expect(res.status).toBe(200);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "user-1",
          action: "approval.rejected",
          entityType: "approval",
          entityId: "approval-2",
        }),
      );
    });

    it("does NOT emit when reject was a no-op (already-rejected idempotent retry)", async () => {
      // Companion to the existing idempotency test in
      // approval-routes-idempotency.test.ts — pinning the same negative
      // invariant from the decision-audit angle so both files are
      // self-contained.
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-2",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      });
      mockApprovalService.reject.mockResolvedValue({
        approval: {
          id: "approval-2",
          companyId: "company-1",
          type: "hire_agent",
          status: "rejected",
          payload: {},
        },
        applied: false,
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-2/reject")
        .send({});

      expect(res.status).toBe(200);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  // -- request-revision ----------------------------------------------

  describe("POST /approvals/:id/request-revision", () => {
    it("emits approval.revision_requested with founder identity + approval scope", async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-3",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
      });
      mockApprovalService.requestRevision.mockResolvedValue({
        id: "approval-3",
        companyId: "company-1",
        type: "hire_agent",
        status: "revision_requested",
        payload: {},
      });

      const res = await request(await createBoardApp())
        .post("/api/approvals/approval-3/request-revision")
        .send({ decisionNote: "tighten the scope" });

      expect(res.status).toBe(200);
      // Unlike approve/reject, requestRevision has no `applied` short-circuit
      // — every call writes the audit row. Pinning that contract here so a
      // refactor can't silently introduce one.
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "user-1",
          action: "approval.revision_requested",
          entityType: "approval",
          entityId: "approval-3",
        }),
      );
    });
  });
});
