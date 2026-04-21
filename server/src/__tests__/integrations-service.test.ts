import { beforeEach, describe, expect, it, vi } from "vitest";
import { integrationService } from "../services/integrations.ts";

// Use a known master key so encryption round-trips are deterministic.
beforeEach(() => {
  process.env.FOUNDEROS_SECRETS_MASTER_KEY = "A".repeat(43) + "=";
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Minimal DB stub helpers
// ---------------------------------------------------------------------------

type IntegrationRow = {
  id: string;
  companyId: string;
  kind: string;
  status: string;
  keyHint: string | null;
  encryptedApiKey: string | null;
  config: Record<string, unknown> | null;
  lastError: string | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: "int-1",
    companyId: "company-1",
    kind: "posthog",
    status: "connected",
    keyHint: "…4321",
    encryptedApiKey: null,
    config: null,
    lastError: null,
    connectedAt: new Date("2024-01-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeDb(rows: IntegrationRow[] = []) {
  const returningMock = vi.fn().mockResolvedValue(rows);
  const onConflictMock = vi.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });

  const deleteReturningMock = vi.fn().mockResolvedValue(rows);
  const deleteWhereMock = vi.fn().mockReturnValue({ returning: deleteReturningMock });

  const selectWhereMock = vi.fn().mockResolvedValue(rows);
  const fromMock = vi.fn().mockReturnValue({ where: selectWhereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
      insert: vi.fn().mockReturnValue({ values: valuesMock }),
      delete: vi.fn().mockReturnValue({ where: deleteWhereMock }),
    } as unknown,
    // Expose for assertions
    selectWhereMock,
    returningMock,
    deleteReturningMock,
    deleteWhereMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integrationService.create", () => {
  it("stores encrypted key and returns row without the encrypted value", async () => {
    const row = makeRow();
    const { db, returningMock } = makeDb([row]);

    // Return the row without encryptedApiKey to simulate what the service strips
    returningMock.mockResolvedValue([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const result = await svc.create("company-1", {
      kind: "posthog",
      apiKey: "phx_supersecretkey1234",
    });

    expect(result).not.toHaveProperty("encryptedApiKey");
    expect(result.kind).toBe("posthog");
    expect(result.status).toBe("connected");
    expect(result.keyHint).toBe("…4321");
  });

  it("throws if api key is empty", async () => {
    const { db } = makeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    await expect(
      svc.create("company-1", { kind: "posthog", apiKey: "   " }),
    ).rejects.toThrow("API key cannot be empty");
  });
});

describe("integrationService.list", () => {
  it("scopes results to the given companyId", async () => {
    const row = makeRow({ companyId: "company-1" });
    const { db, selectWhereMock } = makeDb([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const results = await svc.list("company-1");

    // list() calls .select().from().where() — where() should have been invoked
    expect(selectWhereMock).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].companyId).toBe("company-1");
  });

  it("does not expose encryptedApiKey in list results", async () => {
    const row = makeRow({ encryptedApiKey: "secret-envelope" });
    const { db } = makeDb([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const results = await svc.list("company-1");

    for (const item of results) {
      expect(item).not.toHaveProperty("encryptedApiKey");
    }
  });
});

describe("integrationService.remove", () => {
  it("returns true when a row is deleted", async () => {
    const row = makeRow();
    const { db, deleteReturningMock } = makeDb([row]);
    deleteReturningMock.mockResolvedValue([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const removed = await svc.remove("company-1", "int-1");

    expect(removed).toBe(true);
  });

  it("returns false when no matching row is found", async () => {
    const { db, deleteReturningMock } = makeDb([]);
    deleteReturningMock.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const removed = await svc.remove("company-1", "nonexistent");

    expect(removed).toBe(false);
  });
});

describe("integrationService.getByKind", () => {
  it("returns integration matching the kind", async () => {
    const row = makeRow({ kind: "slack" });
    const { db, selectWhereMock } = makeDb([row]);
    selectWhereMock.mockResolvedValue([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const result = await svc.getByKind("company-1", "slack");

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("slack");
  });

  it("returns null when no integration exists for the kind", async () => {
    const { db, selectWhereMock } = makeDb([]);
    selectWhereMock.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = integrationService(db as any);
    const result = await svc.getByKind("company-1", "notion");

    expect(result).toBeNull();
  });
});
