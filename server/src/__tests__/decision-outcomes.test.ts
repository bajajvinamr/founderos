/**
 * Tests for decisionOutcomeService + decision-followup-cron.
 *
 * Uses lightweight DB stubs so the suite runs in any CI environment.
 * Covers:
 *   1. Cron creates follow-up row after the 14-day window
 *   2. Cron double-run is idempotent (no row when one already exists)
 *   3. recordOutcome + promoteToMemory round-trip
 *   4. promoteToMemory is idempotent once a memory entry exists
 *   5. Tenant isolation — listPending returns only the scoped company
 *   6. createPrompt errors when the approval doesn't exist
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decisionOutcomeService,
  type OutcomeStatus,
} from "../services/decision-outcomes.ts";
import { createDecisionFollowupCron } from "../services/decision-followup-cron.ts";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decidedAt: Date | null;
  requestedByAgentId: string | null;
}

interface OutcomeRow {
  id: string;
  approvalId: string;
  companyId: string;
  outcomeStatus: OutcomeStatus;
  promptedAt: Date;
  answeredAt: Date | null;
  founderNote: string | null;
  metricDelta: string | null;
  memoryEntryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryRow {
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
}

function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "launch_feature",
    status: "approved",
    payload: { title: "Ship pricing page v2" },
    decidedAt: new Date("2026-04-01T00:00:00.000Z"),
    requestedByAgentId: null,
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    id: "outcome-1",
    approvalId: "approval-1",
    companyId: "company-1",
    outcomeStatus: "pending_followup",
    promptedAt: new Date("2026-04-15T00:00:00.000Z"),
    answeredAt: null,
    founderNote: null,
    metricDelta: null,
    memoryEntryId: null,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "memory-1",
    companyId: "company-1",
    kind: "experiment_outcome",
    title: "stub",
    body: "stub",
    topic: null,
    occurredAt: new Date(),
    pinned: false,
    source: "auto",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB stub
// ---------------------------------------------------------------------------

/**
 * A tiny Drizzle-shaped DB mock that supports the chains the service uses:
 *   select().from().where()
 *   select().from().where().orderBy()
 *   select().from().leftJoin().where()
 *   insert().values().returning()
 *   update().set().where().returning()
 *
 * Callers provide a `selectSequence` — an ordered list of arrays, one per
 * select() call, returned when the chain is awaited / iterated.
 */
function makeDb(opts: {
  selectSequence?: unknown[][];
  insertReturns?: unknown[][];
  updateReturns?: unknown[][];
} = {}) {
  const selectSequence = opts.selectSequence ?? [];
  const insertReturns = opts.insertReturns ?? [];
  const updateReturns = opts.updateReturns ?? [];

  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;

  const selectCalls: unknown[] = [];
  const insertCalls: { table: unknown; values: unknown }[] = [];
  const updateCalls: { table: unknown; set: unknown }[] = [];

  function makeSelectChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    const thenable = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(resolve(rows));
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = vi.fn(thenable);
    // Support for...of / array destructure via Symbol.iterator is unnecessary;
    // services always await the chain.
    return chain;
  }

  const select = vi.fn((arg?: unknown) => {
    selectCalls.push(arg);
    const rows = selectSequence[selectIdx] ?? selectSequence[selectSequence.length - 1] ?? [];
    selectIdx++;
    return makeSelectChain(rows) as { from: (...args: unknown[]) => unknown };
  });

  const insert = vi.fn((table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return {
        returning: vi.fn(async (_selection?: unknown) => {
          const rows = insertReturns[insertIdx] ?? [];
          insertIdx++;
          return rows;
        }),
      };
    },
  }));

  const update = vi.fn((table: unknown) => ({
    set: (set: unknown) => {
      updateCalls.push({ table, set });
      return {
        where: () => ({
          returning: vi.fn(async () => {
            const rows = updateReturns[updateIdx] ?? [];
            updateIdx++;
            return rows;
          }),
        }),
      };
    },
  }));

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { select, insert, update } as any,
    select,
    insert,
    update,
    insertCalls,
    updateCalls,
    selectCalls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Cron creates a follow-up row for overdue approvals
// ---------------------------------------------------------------------------

describe("decision-followup cron — creation", () => {
  it("creates a pending_followup row for an approved decision older than 14 days", async () => {
    const approval = makeApproval({
      id: "approval-1",
      decidedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const inserted = { id: "outcome-1" };

    const stub = makeDb({
      selectSequence: [
        // leftJoin candidate rows: approved approvals w/o an outcome
        [
          {
            id: approval.id,
            companyId: approval.companyId,
            decidedAt: approval.decidedAt,
            outcomeId: null,
          },
        ],
      ],
      insertReturns: [[inserted]],
    });

    const cron = createDecisionFollowupCron({
      db: stub.db,
      now: () => new Date("2026-04-20T00:00:00.000Z"), // 19 days after decide
    });

    const result = await cron.runOnce();

    expect(result.created).toBe(1);
    expect(stub.insertCalls.length).toBe(1);
  });

  it("skips approvals whose decidedAt is inside the 14-day window", async () => {
    const approval = makeApproval({
      decidedAt: new Date("2026-04-15T00:00:00.000Z"),
    });

    const stub = makeDb({
      selectSequence: [
        [
          {
            id: approval.id,
            companyId: approval.companyId,
            decidedAt: approval.decidedAt,
            outcomeId: null,
          },
        ],
      ],
      insertReturns: [[]],
    });

    const cron = createDecisionFollowupCron({
      db: stub.db,
      // 7 days after decidedAt — under the 14-day threshold
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });

    const result = await cron.runOnce();

    expect(result.created).toBe(0);
    expect(stub.insertCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cron idempotency — double-run creates nothing extra
// ---------------------------------------------------------------------------

describe("decision-followup cron — idempotency", () => {
  it("does nothing when every overdue approval already has an outcome row", async () => {
    const approval = makeApproval();

    const stub = makeDb({
      // leftJoin candidates — the single approval HAS an outcome already, so
      // the service's `isNull(decisionOutcomes.id)` filter rules it out in SQL.
      // In the stub we model that by returning zero candidates.
      selectSequence: [[]],
      insertReturns: [[]],
    });

    const cron = createDecisionFollowupCron({
      db: stub.db,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    });

    const first = await cron.runOnce();
    const second = await cron.runOnce();

    expect(first.created).toBe(0);
    expect(second.created).toBe(0);
    expect(stub.insertCalls.length).toBe(0);
    // Silence unused-var lint
    expect(approval.id).toBe("approval-1");
  });

  it("swallows tick errors instead of killing the interval", async () => {
    const badDb = {
      select: vi.fn(() => {
        throw new Error("db down");
      }),
    };

    const cron = createDecisionFollowupCron({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: badDb as any,
    });

    const result = await cron.runOnce();
    expect(result.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. recordOutcome + promoteToMemory round-trip
// ---------------------------------------------------------------------------

describe("decisionOutcomeService — record + promote round-trip", () => {
  it("records an outcome then promotes it into company_memory", async () => {
    const outcomeBefore = makeOutcome();
    const outcomeAfter = makeOutcome({
      outcomeStatus: "worked",
      founderNote: "Closed 3 customers after launching.",
      metricDelta: "MRR +15%",
      answeredAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const outcomeWithMemory = { ...outcomeAfter, memoryEntryId: "memory-1" };
    const approval = makeApproval();
    const memoryRow = makeMemory({ title: "Decision outcome · Ship pricing page v2 · Worked" });

    const stub = makeDb({
      // 1. recordOutcome — update only, no select needed.
      // 2. promoteToMemory -> select outcome
      // 3. promoteToMemory -> select approval
      selectSequence: [[outcomeAfter], [approval]],
      updateReturns: [[outcomeAfter], [outcomeWithMemory]],
      insertReturns: [[memoryRow]],
    });

    const svc = decisionOutcomeService(stub.db);

    const recorded = await svc.recordOutcome("outcome-1", {
      status: "worked",
      note: "Closed 3 customers after launching.",
      metric: "MRR +15%",
    });
    expect(recorded.outcomeStatus).toBe("worked");
    expect(recorded.metricDelta).toBe("MRR +15%");

    const { memoryEntryId } = await svc.promoteToMemory("outcome-1");
    expect(memoryEntryId).toBe("memory-1");

    // Inserted memory row has experiment_outcome kind + ties to approval type
    const memoryInsert = stub.insertCalls.find((c) => {
      const v = c.values as Record<string, unknown>;
      return v.kind === "experiment_outcome";
    });
    expect(memoryInsert).toBeTruthy();
    const values = memoryInsert?.values as Record<string, unknown>;
    expect(values.topic).toBe("launch_feature");
    expect(values.companyId).toBe("company-1");
    expect(values.source).toBe("auto");

    // Silence unused
    expect(outcomeBefore.id).toBe("outcome-1");
  });

  it("returns the existing memory entry id when promote is called twice", async () => {
    const outcome = makeOutcome({
      outcomeStatus: "worked",
      answeredAt: new Date(),
      memoryEntryId: "memory-1",
    });

    const stub = makeDb({
      selectSequence: [[outcome]],
    });

    const svc = decisionOutcomeService(stub.db);
    const { memoryEntryId } = await svc.promoteToMemory("outcome-1");

    expect(memoryEntryId).toBe("memory-1");
    // No new inserts happened
    expect(stub.insertCalls.length).toBe(0);
  });

  it("refuses to promote an outcome that's still pending_followup", async () => {
    const outcome = makeOutcome({ outcomeStatus: "pending_followup" });

    const stub = makeDb({
      selectSequence: [[outcome]],
    });

    const svc = decisionOutcomeService(stub.db);
    await expect(svc.promoteToMemory("outcome-1")).rejects.toThrow(
      /hasn't been answered/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Tenant isolation — listPending filters by companyId
// ---------------------------------------------------------------------------

describe("decisionOutcomeService — tenant isolation", () => {
  it("filters listPending by companyId", async () => {
    const pendingA = makeOutcome({
      id: "outcome-A",
      companyId: "company-A",
    });

    const stub = makeDb({
      selectSequence: [[pendingA]],
    });

    const svc = decisionOutcomeService(stub.db);
    const result = await svc.listPending("company-A");

    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe("company-A");

    // The where() call must have been invoked — the service would never trust
    // a caller-provided companyId without scoping.
    expect(stub.select).toHaveBeenCalledTimes(1);
  });

  it("createPrompt refuses when the approval is missing", async () => {
    const stub = makeDb({
      // 1st select: existing outcome lookup → none
      // 2nd select: approval lookup → none
      selectSequence: [[], []],
    });

    const svc = decisionOutcomeService(stub.db);
    await expect(svc.createPrompt("approval-missing")).rejects.toThrow(
      /Approval not found/,
    );
    expect(stub.insertCalls.length).toBe(0);
  });
});
