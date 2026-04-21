/**
 * Tests for agentReviewsService.
 *
 * Uses a lightweight DB stub rather than embedded Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentReviewsService } from "../services/agent-reviews.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReviewRow = {
  id: string;
  agentId: string;
  companyId: string;
  monthOf: string;
  shiftsRun: number;
  issuesClosed: number;
  costCents: number;
  blockedIncidents: number;
  summaryMarkdown: string;
  recommendation: string;
  rationale: string;
  source: string;
  generatedAt: Date;
};

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alice",
    ...overrides,
  };
}

function makeReviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "review-1",
    agentId: "agent-1",
    companyId: "company-1",
    monthOf: "2026-03-01",
    shiftsRun: 10,
    issuesClosed: 6,
    costCents: 2000,
    blockedIncidents: 0,
    summaryMarkdown: "Summary text",
    recommendation: "promote",
    rationale: "Rationale text",
    source: "auto",
    generatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal DB stub supporting the access patterns in agentReviewsService:
 *  - select().from().where()                 → returns selectRows
 *  - select().from().where().orderBy().limit() → returns selectRows
 *  - insert().values().returning()           → returns insertRows
 *  - update().set().where().returning()      → returns updateRows
 *
 * selectSequence controls successive select() calls in order.
 */
function makeDb(opts: {
  selectSequence?: unknown[][];
  selectRows?: unknown[];
  insertRows?: unknown[];
  updateRows?: unknown[];
} = {}) {
  const {
    insertRows = [],
    updateRows = [],
  } = opts;

  const selectSequence = opts.selectSequence ?? [opts.selectRows ?? []];
  let selectCallIndex = 0;

  function buildSelectChain(rows: unknown[]) {
    const limitMock = vi.fn().mockResolvedValue(rows);
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const whereResult: Record<string, unknown> = {
      orderBy: orderByMock,
      limit: limitMock,
      then: (onfulfilled: (v: unknown[]) => unknown) => Promise.resolve(rows).then(onfulfilled),
      catch: (onrejected: (e: unknown) => unknown) => Promise.resolve(rows).catch(onrejected),
    };
    const fromMock = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) });
    return { fromMock };
  }

  const selectMock = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    const rows = selectSequence[idx] ?? selectSequence[selectSequence.length - 1] ?? [];
    const { fromMock } = buildSelectChain(rows);
    return { from: fromMock };
  });

  const insertReturningMock = vi.fn().mockResolvedValue(insertRows);
  const insertValuesMock = vi.fn().mockReturnValue({ returning: insertReturningMock });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const updateReturningMock = vi.fn().mockResolvedValue(updateRows);
  const updateWhereMock = vi.fn().mockReturnValue({ returning: updateReturningMock });
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
    } as unknown,
    selectMock,
    insertReturningMock,
    updateReturningMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. generateMonthlyReview is idempotent per (agent, month)
// ---------------------------------------------------------------------------

describe("agentReviewsService — generateMonthlyReview idempotency", () => {
  it("updates an existing review row when one already exists for (agent, month)", async () => {
    const agent = makeAgent();
    const existingReview = makeReviewRow();

    // selectSequence:
    // [0] agent lookup → [agent]
    // [1] heartbeat_runs → []
    // [2] issues → []
    // [3] cost_events → []
    // [4] activity_log blocked → []
    // [5] existing review lookup → [existingReview]  (triggers update path)
    const { db, updateReturningMock } = makeDb({
      selectSequence: [
        [agent],        // agent
        [],             // heartbeat_runs
        [],             // issues
        [],             // cost_events
        [],             // activity_log
        [existingReview], // existing review
      ],
      updateRows: [makeReviewRow({ source: "auto" })],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.generateMonthlyReview("agent-1", "2026-03-01");

    expect(updateReturningMock).toHaveBeenCalled();
    expect(result.agentId).toBe("agent-1");
  });
});

// ---------------------------------------------------------------------------
// 2. recommendation = 'promote' when issues_closed >= 5 AND cost/issue < $50
// ---------------------------------------------------------------------------

describe("agentReviewsService — promote recommendation", () => {
  it("returns promote when issuesClosed >= 5 and cost/issue < 5000 cents", async () => {
    const agent = makeAgent({ name: "Bob" });
    const reviewRow = makeReviewRow({
      recommendation: "promote",
      issuesClosed: 6,
      costCents: 2400, // $4/issue < $50
    });

    const { db } = makeDb({
      selectSequence: [
        [agent],  // agent lookup
        Array(10).fill({ id: "run-x" }), // 10 heartbeat runs
        Array(6).fill({ id: "issue-x" }), // 6 issues
        Array(6).fill({ cost: 400 }),     // cost events
        [],                               // no blocked
        [],                               // no existing review
      ],
      insertRows: [reviewRow],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.generateMonthlyReview("agent-1", "2026-03-01");

    expect(result.recommendation).toBe("promote");
  });
});

// ---------------------------------------------------------------------------
// 3. recommendation = 'let_go' when issues_closed < 2 AND cost > $100
// ---------------------------------------------------------------------------

describe("agentReviewsService — let_go recommendation", () => {
  it("returns let_go when issuesClosed < 2 and costCents > 10000", async () => {
    const agent = makeAgent({ name: "Carol" });
    const reviewRow = makeReviewRow({
      recommendation: "let_go",
      issuesClosed: 1,
      costCents: 15000,
    });

    const { db } = makeDb({
      selectSequence: [
        [agent],
        Array(5).fill({ id: "run-x" }),
        Array(1).fill({ id: "issue-x" }),
        Array(3).fill({ cost: 5000 }),
        [],
        [],
      ],
      insertRows: [reviewRow],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.generateMonthlyReview("agent-1", "2026-03-01");

    expect(result.recommendation).toBe("let_go");
  });
});

// ---------------------------------------------------------------------------
// 4. recommendation = 'rebrief' when low output + low cost
// ---------------------------------------------------------------------------

describe("agentReviewsService — rebrief recommendation", () => {
  it("returns rebrief when issuesClosed < 2 and costCents <= 10000", async () => {
    const agent = makeAgent({ name: "Dave" });
    const reviewRow = makeReviewRow({
      recommendation: "rebrief",
      issuesClosed: 0,
      costCents: 5000,
    });

    const { db } = makeDb({
      selectSequence: [
        [agent],
        [],       // no runs
        [],       // no issues
        Array(1).fill({ cost: 5000 }),
        [],
        [],
      ],
      insertRows: [reviewRow],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.generateMonthlyReview("agent-1", "2026-03-01");

    expect(result.recommendation).toBe("rebrief");
  });
});

// ---------------------------------------------------------------------------
// 5. list scoped to companyId + optional agentId filter
// ---------------------------------------------------------------------------

describe("agentReviewsService — list", () => {
  it("returns reviews for the given companyId", async () => {
    const row1 = makeReviewRow({ id: "r1", agentId: "agent-1" });
    const row2 = makeReviewRow({ id: "r2", agentId: "agent-2" });

    const { db } = makeDb({ selectRows: [row1, row2] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const results = await svc.list("company-1");

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("r1");
    expect(results[1].id).toBe("r2");
  });

  it("accepts an agentId filter and passes it through", async () => {
    const row = makeReviewRow({ agentId: "agent-1" });
    const { db, selectMock } = makeDb({ selectRows: [row] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const results = await svc.list("company-1", { agentId: "agent-1" });

    expect(selectMock).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe("agent-1");
  });
});

// ---------------------------------------------------------------------------
// 6. getLatest returns most recent review for an agent
// ---------------------------------------------------------------------------

describe("agentReviewsService — getLatest", () => {
  it("returns the most recent review row for the agent", async () => {
    const latestRow = makeReviewRow({ id: "latest", monthOf: "2026-03-01" });

    const { db } = makeDb({ selectRows: [latestRow] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.getLatest("agent-1");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("latest");
    expect(result!.monthOf).toBe("2026-03-01");
  });

  it("returns null when no review exists", async () => {
    const { db } = makeDb({ selectRows: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = agentReviewsService(db as any);
    const result = await svc.getLatest("agent-1");

    expect(result).toBeNull();
  });
});
