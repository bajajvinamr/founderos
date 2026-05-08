import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

const mockCompanyCreate = vi.fn().mockResolvedValue({
  id: "company-uuid-new",
  name: "Acme",
  budgetMonthlyCents: 0,
});
const mockEnsureMembership = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: mockCompanyCreate,
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: mockEnsureMembership,
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

describe("company routes malformed issue path guard", () => {
  it("returns a clear error when companyId is missing for issues list path", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any));

    const res = await request(app).get("/api/companies/issues");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });
});

describe("POST /api/companies SaaS access (no instance-admin gate)", () => {
  it("allows a normal signed-in board user (not instance admin) to create their first company", async () => {
    mockCompanyCreate.mockClear();
    mockEnsureMembership.mockClear();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-123",
        source: "session",
        companyIds: [],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api/companies", companyRoutes({} as any));
    // Errors thrown by route handlers in this test surface as plain status
    // codes — no app-level error middleware is wired in this isolated harness.
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app)
      .post("/api/companies")
      .send({ name: "Acme", budgetMonthlyCents: 0 });

    expect(res.status).toBe(201);
    expect(mockCompanyCreate).toHaveBeenCalledTimes(1);
    expect(mockEnsureMembership).toHaveBeenCalledWith(
      "company-uuid-new",
      "user",
      "user-123",
      "owner",
      "active",
    );
  });
});
