/**
 * Tests for the `slack.post_message` skill.
 *
 * Covers:
 *   1. Happy path — `autonomous` permission posts via Slack and logs to audit.
 *   2. `observe` permission throws (blocked).
 *   3. No Slack integration connected → no-ops with { ok: false, reason }.
 *   4. `channel_not_found` Slack error is surfaced as a typed result.
 *   5. `draft` permission creates a pending approval (Decision Inbox).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockPostMessage = vi.hoisted(() => vi.fn());
const mockCreateSlackClient = vi.hoisted(() =>
  vi.fn(() => ({
    listChannels: vi.fn(),
    postMessage: mockPostMessage,
  })),
);
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDecryptWithMasterKey = vi.hoisted(() =>
  vi.fn(() => "xoxb-decrypted-bot-token"),
);

vi.mock("../services/slack-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/slack-client.ts")
  >("../services/slack-client.ts");
  return {
    ...actual,
    createSlackClient: mockCreateSlackClient,
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../secrets/local-encrypted-provider.js", () => ({
  decryptWithMasterKey: mockDecryptWithMasterKey,
  encryptWithMasterKey: vi.fn(),
}));

// Avoid the logger pulling in pino file transports during tests.
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

import { executeSlackPostMessage } from "../services/skills/slack-post-message.ts";
import type { Db } from "@founderos/db";

// ─── Helpers ──────────────────────────────────────────────────────────────

type FakeIntegrationRow = {
  id: string;
  companyId: string;
  kind: string;
  encryptedApiKey: string | null;
} | null;

/**
 * Build a minimal Drizzle-shaped stub for the two queries the skill makes:
 *   - `db.select().from(integrations).where(...)`   → returns [integrationRow?]
 *   - `db.insert(approvals).values(...).returning(...)` → returns [{ id }]
 */
function createDbStub(options: {
  integrationRow: FakeIntegrationRow;
  insertReturning?: Array<{ id: string }>;
}) {
  const { integrationRow, insertReturning = [{ id: "approval-123" }] } = options;

  const selectWhere = vi.fn(async () => (integrationRow ? [integrationRow] : []));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturningFn = vi.fn(async () => insertReturning);
  const insertValues = vi.fn(() => ({ returning: insertReturningFn }));
  const insert = vi.fn(() => ({ values: insertValues }));

  return {
    db: { select, insert } as unknown as Db,
    selectWhere,
    insert,
    insertValues,
  };
}

function createIntegrationRow(overrides?: Partial<NonNullable<FakeIntegrationRow>>): NonNullable<FakeIntegrationRow> {
  return {
    id: "integration-1",
    companyId: "company-1",
    kind: "slack",
    encryptedApiKey: "encrypted-blob",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("executeSlackPostMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptWithMasterKey.mockReturnValue("xoxb-decrypted-bot-token");
  });

  it("happy path: autonomous posts to Slack and logs to audit_log", async () => {
    const { db } = createDbStub({ integrationRow: createIntegrationRow() });
    mockPostMessage.mockResolvedValueOnce({ ok: true, ts: "1700000000.001" });

    const result = await executeSlackPostMessage(
      {
        db,
        companyId: "company-1",
        permissionLevel: "autonomous",
        agentId: "agent-cos-1",
      },
      { channelId: "C123", text: "Weekly wrap ready." },
    );

    expect(result).toEqual({
      ok: true,
      status: "posted",
      channelId: "C123",
      ts: "1700000000.001",
    });
    expect(mockCreateSlackClient).toHaveBeenCalledWith({
      botToken: "xoxb-decrypted-bot-token",
    });
    expect(mockPostMessage).toHaveBeenCalledWith("C123", "Weekly wrap ready.", undefined);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "slack.message_posted",
        entityType: "integration",
        entityId: "integration-1",
        agentId: "agent-cos-1",
        actorType: "agent",
      }),
    );
  });

  it("observe permission blocks the call (throws)", async () => {
    const { db } = createDbStub({ integrationRow: createIntegrationRow() });

    await expect(
      executeSlackPostMessage(
        {
          db,
          companyId: "company-1",
          permissionLevel: "observe",
          agentId: "agent-cos-1",
        },
        { channelId: "C123", text: "hi" },
      ),
    ).rejects.toThrow(/observe mode/i);

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("no integration connected returns { ok: false, reason: 'no_integration' } (no-op)", async () => {
    const { db } = createDbStub({ integrationRow: null });

    const result = await executeSlackPostMessage(
      {
        db,
        companyId: "company-1",
        permissionLevel: "autonomous",
        agentId: "agent-cos-1",
      },
      { channelId: "C123", text: "hi" },
    );

    expect(result).toEqual({
      ok: false,
      reason: "no_integration",
      message: expect.any(String),
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockCreateSlackClient).not.toHaveBeenCalled();
  });

  it("channel_not_found surfaces as typed result (autonomous)", async () => {
    const { db } = createDbStub({ integrationRow: createIntegrationRow() });
    mockPostMessage.mockResolvedValueOnce({
      ok: false,
      error: "channel_not_found",
    });

    const result = await executeSlackPostMessage(
      {
        db,
        companyId: "company-1",
        permissionLevel: "autonomous",
        agentId: "agent-cos-1",
      },
      { channelId: "C-invalid", text: "hi" },
    );

    expect(result).toEqual({
      ok: false,
      reason: "channel_not_found",
      message: "channel_not_found",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "slack.message_post_failed",
      }),
    );
  });

  it("draft permission creates a pending approval instead of posting", async () => {
    const { db, insertValues } = createDbStub({
      integrationRow: createIntegrationRow(),
    });

    const result = await executeSlackPostMessage(
      {
        db,
        companyId: "company-1",
        permissionLevel: "draft",
        agentId: "agent-cos-1",
      },
      { channelId: "C123", text: "Weekly wrap draft" },
    );

    expect(result).toEqual({
      ok: true,
      status: "pending_approval",
      channelId: "C123",
      approvalId: "approval-123",
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "slack.post_message",
        status: "pending",
        requestedByAgentId: "agent-cos-1",
        payload: expect.objectContaining({
          channelId: "C123",
          text: "Weekly wrap draft",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "slack.message_pending_approval",
      }),
    );
  });
});
