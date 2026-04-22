/**
 * Tests for the Wave 18A HubSpot action skills:
 *   - `hubspot.create_contact`
 *   - `hubspot.log_note`
 *   - `hubspot.move_deal`
 *
 * Covers:
 *   1. Happy path (autonomous) for each of the 3 skills — mocked HubSpot
 *      client methods + audit_log activity entry.
 *   2. `observe` permission throws (blocked) — one skill is sufficient as
 *      all three share the same gate; we exercise it on `create_contact`.
 *   3. No HubSpot integration connected → `{ ok:false, reason:"no_integration" }`.
 *   4. `draft` permission creates a pending approval row (per skill).
 *   5. Malformed input is rejected synchronously.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockCreateContact = vi.hoisted(() => vi.fn());
const mockCreateNote = vi.hoisted(() => vi.fn());
const mockAssociateNoteToContact = vi.hoisted(() => vi.fn());
const mockUpdateDealStage = vi.hoisted(() => vi.fn());

const mockCreateHubspotClient = vi.hoisted(() =>
  vi.fn(() => ({
    getDealPipelines: vi.fn(),
    getDeals: vi.fn(),
    createContact: mockCreateContact,
    createNote: mockCreateNote,
    associateNoteToContact: mockAssociateNoteToContact,
    updateDealStage: mockUpdateDealStage,
  })),
);

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockDecryptWithMasterKey = vi.hoisted(() =>
  vi.fn(() => "pat-na1-decrypted-token"),
);

vi.mock("../services/hubspot-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/hubspot-client.ts")
  >("../services/hubspot-client.ts");
  return {
    ...actual,
    createHubspotClient: mockCreateHubspotClient,
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../secrets/local-encrypted-provider.js", () => ({
  decryptWithMasterKey: mockDecryptWithMasterKey,
  encryptWithMasterKey: vi.fn(),
}));

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

import { executeHubspotCreateContact } from "../services/skills/hubspot-create-contact.ts";
import { executeHubspotLogNote } from "../services/skills/hubspot-log-note.ts";
import { executeHubspotMoveDeal } from "../services/skills/hubspot-move-deal.ts";
import type { Db } from "@founderos/db";

// ─── Helpers ──────────────────────────────────────────────────────────────

type FakeIntegrationRow = {
  id: string;
  companyId: string;
  kind: string;
  encryptedApiKey: string | null;
} | null;

function createDbStub(options: {
  integrationRow: FakeIntegrationRow;
  insertReturning?: Array<{ id: string }>;
}) {
  const { integrationRow, insertReturning = [{ id: "approval-999" }] } = options;

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

function createIntegrationRow(
  overrides?: Partial<NonNullable<FakeIntegrationRow>>,
): NonNullable<FakeIntegrationRow> {
  return {
    id: "hubspot-integration-1",
    companyId: "company-1",
    kind: "hubspot",
    encryptedApiKey: "encrypted-blob",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("hubspot action skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptWithMasterKey.mockReturnValue("pat-na1-decrypted-token");
  });

  // ── hubspot.create_contact ────────────────────────────────────────────

  describe("executeHubspotCreateContact", () => {
    it("happy path: autonomous creates contact and logs to audit_log", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });
      mockCreateContact.mockResolvedValueOnce({
        id: "contact-501",
        properties: { email: "jane@example.com", firstname: "Jane" },
      });

      const result = await executeHubspotCreateContact(
        {
          db,
          companyId: "company-1",
          permissionLevel: "autonomous",
          agentId: "agent-bd-1",
        },
        {
          email: "jane@example.com",
          firstName: "Jane",
          lastName: "Doe",
          company: "Acme",
        },
      );

      expect(result).toEqual({
        ok: true,
        status: "created",
        contactId: "contact-501",
        url: expect.stringContaining("contact-501"),
      });
      expect(mockCreateHubspotClient).toHaveBeenCalledWith({
        accessToken: "pat-na1-decrypted-token",
      });
      expect(mockCreateContact).toHaveBeenCalledWith({
        email: "jane@example.com",
        firstName: "Jane",
        lastName: "Doe",
        company: "Acme",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          action: "hubspot.create_contact_executed",
          entityType: "integration",
          entityId: "hubspot-integration-1",
          agentId: "agent-bd-1",
          actorType: "agent",
        }),
      );
    });

    it("observe permission blocks the call (throws)", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });

      await expect(
        executeHubspotCreateContact(
          {
            db,
            companyId: "company-1",
            permissionLevel: "observe",
            agentId: "agent-bd-1",
          },
          { email: "jane@example.com" },
        ),
      ).rejects.toThrow(/observe mode/i);

      expect(mockCreateContact).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("no integration short-circuits with { ok:false, reason:'no_integration' }", async () => {
      const { db } = createDbStub({ integrationRow: null });

      const result = await executeHubspotCreateContact(
        {
          db,
          companyId: "company-1",
          permissionLevel: "autonomous",
          agentId: "agent-bd-1",
        },
        { email: "jane@example.com" },
      );

      expect(result).toEqual({
        ok: false,
        reason: "no_integration",
        message: expect.any(String),
      });
      expect(mockCreateContact).not.toHaveBeenCalled();
      expect(mockCreateHubspotClient).not.toHaveBeenCalled();
    });

    it("draft permission creates a pending approval instead of writing", async () => {
      const { db, insertValues } = createDbStub({
        integrationRow: createIntegrationRow(),
      });

      const result = await executeHubspotCreateContact(
        {
          db,
          companyId: "company-1",
          permissionLevel: "draft",
          agentId: "agent-bd-1",
        },
        { email: "jane@example.com", firstName: "Jane" },
      );

      expect(result).toEqual({
        ok: true,
        status: "pending_approval",
        approvalId: "approval-999",
      });
      expect(mockCreateContact).not.toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          type: "hubspot.create_contact",
          status: "pending",
          requestedByAgentId: "agent-bd-1",
          payload: expect.objectContaining({
            email: "jane@example.com",
            firstName: "Jane",
          }),
        }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "hubspot.create_contact_pending_approval",
        }),
      );
    });

    it("rejects malformed email input synchronously", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });

      await expect(
        executeHubspotCreateContact(
          {
            db,
            companyId: "company-1",
            permissionLevel: "autonomous",
            agentId: "agent-bd-1",
          },
          { email: "not-an-email" },
        ),
      ).rejects.toThrow(/not a valid email/i);

      expect(mockCreateContact).not.toHaveBeenCalled();
    });
  });

  // ── hubspot.log_note ──────────────────────────────────────────────────

  describe("executeHubspotLogNote", () => {
    it("happy path: autonomous creates note, associates to contact, audits", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });
      mockCreateNote.mockResolvedValueOnce({
        id: "note-777",
        properties: { hs_note_body: "Called today" },
      });
      mockAssociateNoteToContact.mockResolvedValueOnce(undefined);

      const result = await executeHubspotLogNote(
        {
          db,
          companyId: "company-1",
          permissionLevel: "autonomous",
          agentId: "agent-bd-1",
        },
        { contactId: "contact-501", body: "Called today, will follow up." },
      );

      expect(result).toEqual({
        ok: true,
        status: "logged",
        noteId: "note-777",
      });
      expect(mockCreateNote).toHaveBeenCalledWith({
        body: "Called today, will follow up.",
      });
      expect(mockAssociateNoteToContact).toHaveBeenCalledWith("note-777", "contact-501");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "hubspot.log_note_executed" }),
      );
    });

    it("draft permission creates a pending approval", async () => {
      const { db, insertValues } = createDbStub({
        integrationRow: createIntegrationRow(),
      });

      const result = await executeHubspotLogNote(
        {
          db,
          companyId: "company-1",
          permissionLevel: "draft",
          agentId: "agent-bd-1",
        },
        { contactId: "contact-501", body: "Great call today" },
      );

      expect(result).toEqual({
        ok: true,
        status: "pending_approval",
        approvalId: "approval-999",
      });
      expect(mockCreateNote).not.toHaveBeenCalled();
      expect(mockAssociateNoteToContact).not.toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "hubspot.log_note",
          status: "pending",
          payload: expect.objectContaining({
            contactId: "contact-501",
            body: "Great call today",
          }),
        }),
      );
    });

    it("rejects empty note body synchronously", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });

      await expect(
        executeHubspotLogNote(
          {
            db,
            companyId: "company-1",
            permissionLevel: "autonomous",
            agentId: "agent-bd-1",
          },
          { contactId: "contact-501", body: "   " },
        ),
      ).rejects.toThrow(/body.*required/i);

      expect(mockCreateNote).not.toHaveBeenCalled();
    });
  });

  // ── hubspot.move_deal ─────────────────────────────────────────────────

  describe("executeHubspotMoveDeal", () => {
    it("happy path: autonomous PATCHes deal stage and audits", async () => {
      const { db } = createDbStub({ integrationRow: createIntegrationRow() });
      mockUpdateDealStage.mockResolvedValueOnce({
        id: "deal-42",
        properties: { dealstage: "qualifiedtobuy" },
      });

      const result = await executeHubspotMoveDeal(
        {
          db,
          companyId: "company-1",
          permissionLevel: "autonomous",
          agentId: "agent-bd-1",
        },
        { dealId: "deal-42", stageId: "qualifiedtobuy" },
      );

      expect(result).toEqual({
        ok: true,
        status: "moved",
        dealId: "deal-42",
        newStage: "qualifiedtobuy",
      });
      expect(mockUpdateDealStage).toHaveBeenCalledWith("deal-42", "qualifiedtobuy");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "hubspot.move_deal_executed" }),
      );
    });

    it("draft permission creates a pending approval", async () => {
      const { db, insertValues } = createDbStub({
        integrationRow: createIntegrationRow(),
      });

      const result = await executeHubspotMoveDeal(
        {
          db,
          companyId: "company-1",
          permissionLevel: "draft",
          agentId: "agent-bd-1",
        },
        { dealId: "deal-42", stageId: "closedwon" },
      );

      expect(result).toEqual({
        ok: true,
        status: "pending_approval",
        approvalId: "approval-999",
      });
      expect(mockUpdateDealStage).not.toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "hubspot.move_deal",
          status: "pending",
          payload: expect.objectContaining({
            dealId: "deal-42",
            stageId: "closedwon",
          }),
        }),
      );
    });
  });
});
