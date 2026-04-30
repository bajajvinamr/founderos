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
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  accessService: () => mockAccessService,
  secretService: () => mockSecretService,
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  companyMemoryService: () => mockMemoryService,
  validateAnthropicKey: mockValidateAnthropicKey,
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function createApp() {
  const [{ onboardingRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/onboarding.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  // Instance-admin board actor — bypasses the forbidden check in bootstrap.
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
  app.use("/api", onboardingRoutes({} as any));
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
  adapterChoice: "claude_local" | "anthropic_api" | "skip",
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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
