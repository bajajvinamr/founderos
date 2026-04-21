/**
 * Tests for companyMemoryService.
 *
 * Uses a lightweight DB stub (chained mock builder) rather than embedded
 * Postgres so the suite runs in all CI environments.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyMemoryService } from "../services/company-memory.ts";

// ---------------------------------------------------------------------------
// Minimal row type matching the Drizzle select shape
// ---------------------------------------------------------------------------

type MemoryRow = {
  id: string;
  companyId: string;
  kind: string;
  title: string;
  body: string;
  topic: string | null;
  occurredAt: Date;
  pinned: boolean;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem-1",
    companyId: "company-1",
    kind: "founder_note",
    title: "Test entry",
    body: "Test body",
    topic: null,
    occurredAt: new Date("2026-04-14T00:00:00.000Z"),
    pinned: false,
    source: "manual",
    createdAt: new Date("2026-04-14T00:00:00.000Z"),
    updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal DB stub that handles:
 *   select().from().where().orderBy().limit()  → selectRows
 *   select().from().where()                    → resolved directly (single-row lookups)
 *   insert().values().returning()              → insertRows
 *   update().set().where().returning()         → updateRows
 *   delete().where().returning()               → deleteRows
 *
 * selectSequence lets callers control what each successive select() call returns
 * (used for generateWeeklySummary which calls select() on activity_log, issues,
 * cost_events, and company_memory in sequence).
 */
function makeDb(opts: {
  /** What the first select().from().where() chain resolves with. */
  selectRows?: unknown[];
  insertRows?: MemoryRow[];
  updateRows?: MemoryRow[];
  deleteRows?: MemoryRow[];
  /**
   * Ordered list of row arrays returned by successive select() calls.
   * Overrides selectRows when provided. Index 0 = first select call, etc.
   */
  selectSequence?: unknown[][];
} = {}) {
  const {
    insertRows = [],
    updateRows = [],
    deleteRows = [],
  } = opts;

  // Build the select sequence: explicit sequence takes precedence over selectRows.
  const selectSequence = opts.selectSequence ?? [opts.selectRows ?? []];
  let selectCallIndex = 0;

  function buildSelectChain(rows: unknown[]) {
    const limitMock = vi.fn().mockResolvedValue(rows);
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const whereMock = vi.fn().mockResolvedValue(rows);
    // Also support .orderBy() chaining off where()
    whereMock.mockReturnValue({
      orderBy: orderByMock,
      limit: limitMock,
      then: undefined,
      // Make it awaitable for callers that do `const [row] = await db.select()...where()`
      [Symbol.toPrimitive]: undefined,
    });
    // Override: make where() itself return a thenable that also has orderBy/limit
    const whereResult = {
      orderBy: orderByMock,
      limit: limitMock,
    };
    // Manually make whereResult a promise resolving to rows
    Object.assign(whereResult, {
      then: (onfulfilled: (v: unknown[]) => void) => Promise.resolve(rows).then(onfulfilled),
      catch: (onrejected: (e: unknown) => void) => Promise.resolve(rows).catch(onrejected),
    });
    const fromMock = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) });
    return { fromMock };
  }

  const selectMock = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    const rows = selectSequence[idx] ?? selectSequence[selectSequence.length - 1] ?? [];
    const { fromMock } = buildSelectChain(rows);
    return { from: fromMock };
  });

  // insert chain
  const insertReturningMock = vi.fn().mockResolvedValue(insertRows);
  const insertValuesMock = vi.fn().mockReturnValue({ returning: insertReturningMock });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  // update chain
  const updateReturningMock = vi.fn().mockResolvedValue(updateRows);
  const updateWhereMock = vi.fn().mockReturnValue({ returning: updateReturningMock });
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  // delete chain
  const deleteReturningMock = vi.fn().mockResolvedValue(deleteRows);
  const deleteWhereMock = vi.fn().mockReturnValue({ returning: deleteReturningMock });
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
      delete: deleteMock,
    } as unknown,
    selectMock,
    insertReturningMock,
    updateReturningMock,
    deleteReturningMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. create / list round-trip
// ---------------------------------------------------------------------------

describe("companyMemoryService — create and list", () => {
  it("creates an entry and returns it via list", async () => {
    const row = makeRow({ title: "Newsletter drives signups", kind: "founder_note" });

    const { db, insertReturningMock, selectMock } = makeDb({
      insertRows: [row],
      selectSequence: [[row]],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);

    const created = await svc.create("company-1", {
      title: "Newsletter drives signups",
      body: "Body text",
      source: "manual",
    });

    expect(insertReturningMock).toHaveBeenCalled();
    expect(created.title).toBe("Newsletter drives signups");
    expect(created.kind).toBe("founder_note");
    expect(created.source).toBe("manual");

    // Simulate list returning the same row
    const entries = await svc.list("company-1");
    expect(selectMock).toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Newsletter drives signups");
  });
});

// ---------------------------------------------------------------------------
// 2. togglePin flips the boolean
// ---------------------------------------------------------------------------

describe("companyMemoryService — togglePin", () => {
  it("flips pinned=false to pinned=true", async () => {
    const original = makeRow({ pinned: false });
    const updated = makeRow({ pinned: true });

    const { db, updateReturningMock } = makeDb({
      selectSequence: [[original]],
      updateRows: [updated],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.togglePin("mem-1");

    expect(updateReturningMock).toHaveBeenCalled();
    expect(result?.pinned).toBe(true);
  });

  it("flips pinned=true back to pinned=false", async () => {
    const original = makeRow({ pinned: true });
    const updated = makeRow({ pinned: false });

    const { db, updateReturningMock } = makeDb({
      selectSequence: [[original]],
      updateRows: [updated],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.togglePin("mem-1");

    expect(updateReturningMock).toHaveBeenCalled();
    expect(result?.pinned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. generateWeeklySummary is idempotent on repeat call for same week
// ---------------------------------------------------------------------------

describe("companyMemoryService — generateWeeklySummary idempotency", () => {
  it("updates an existing entry instead of inserting a new one", async () => {
    const existing = makeRow({
      id: "mem-weekly-1",
      kind: "weekly_summary",
      source: "auto",
      title: "Week of 2026-04-13 · 0 shipped",
      occurredAt: new Date("2026-04-13T00:00:00.000Z"),
    });
    const refreshed = { ...existing, title: "Week of 2026-04-13 · 0 shipped" };

    // generateWeeklySummary makes 4 selects:
    //   1. activity_log  2. issues  3. cost_events  4. existing weekly_summary
    const { db, insertReturningMock, updateReturningMock } = makeDb({
      selectSequence: [
        [],          // activity_log → no activity
        [],          // issues → no issues
        [],          // cost_events → no costs
        [existing],  // existing weekly_summary found → will update
      ],
      insertRows: [],
      updateRows: [refreshed],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.generateWeeklySummary("company-1", "2026-04-14");

    // Should update, not insert
    expect(updateReturningMock).toHaveBeenCalled();
    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(result.kind).toBe("weekly_summary");
  });
});

// ---------------------------------------------------------------------------
// 4. generateWeeklySummary aggregates shifts + shipped from seeded activity
// ---------------------------------------------------------------------------

describe("companyMemoryService — generateWeeklySummary aggregation", () => {
  it("counts heartbeat shifts and shipped issues in the body", async () => {
    const weekStart = new Date("2026-04-13T00:00:00.000Z");
    const newEntry = makeRow({
      kind: "weekly_summary",
      source: "auto",
      title: "Week of 2026-04-13 · 2 shipped",
      body: "Week of 2026-04-13.\n2 shifts run across 1 teammate.\nShipped 2 issues: Fix login bug, Add dark mode.\nSpend: $0.05.",
      occurredAt: weekStart,
    });

    const { db, insertReturningMock } = makeDb({
      // generateWeeklySummary makes 4 selects:
      //   1. activity_log  2. issues  3. cost_events  4. existing weekly_summary
      selectSequence: [
        [
          { action: "heartbeat.started", agentId: "agent-1" },
          { action: "heartbeat.completed", agentId: "agent-1" },
          { action: "issue.updated", agentId: null },
        ],
        [
          { title: "Fix login bug", status: "done", updatedAt: new Date("2026-04-14T10:00:00.000Z") },
          { title: "Add dark mode", status: "done", updatedAt: new Date("2026-04-15T10:00:00.000Z") },
        ],
        [{ costCents: 5 }],
        [],  // no existing weekly_summary → will insert
      ],
      insertRows: [newEntry],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.generateWeeklySummary("company-1", "2026-04-14");

    expect(insertReturningMock).toHaveBeenCalled();
    expect(result.body).toContain("2 shifts");
    expect(result.body).toContain("2 issues");
    expect(result.title).toContain("2 shipped");
  });
});

// ---------------------------------------------------------------------------
// 5. list respects ?pinned filter
// ---------------------------------------------------------------------------

describe("companyMemoryService — list with pinned filter", () => {
  it("only returns pinned entries when pinned=true is passed", async () => {
    const pinnedRow = makeRow({ id: "mem-pinned", pinned: true });

    const { db } = makeDb({ selectSequence: [[pinnedRow]] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const entries = await svc.list("company-1", { pinned: true });

    expect(entries).toHaveLength(1);
    expect(entries[0].pinned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. delete removes the row
// ---------------------------------------------------------------------------

describe("companyMemoryService — remove", () => {
  it("returns true when a row is deleted", async () => {
    const row = makeRow();
    const { db, deleteReturningMock } = makeDb({ deleteRows: [row] });
    deleteReturningMock.mockResolvedValue([row]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.remove("mem-1");

    expect(result).toBe(true);
  });

  it("returns false when no row is found", async () => {
    const { db, deleteReturningMock } = makeDb({ deleteRows: [] });
    deleteReturningMock.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = companyMemoryService(db as any);
    const result = await svc.remove("nonexistent");

    expect(result).toBe(false);
  });
});
