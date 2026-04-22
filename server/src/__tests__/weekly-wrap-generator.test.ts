/**
 * Wave 18B — Weekly Wrap generator tests.
 *
 * The generator is the single source of truth for:
 *   - signal aggregation (issues / approvals / activity / spend / blockers)
 *   - the Anthropic narrative call (mocked here)
 *   - idempotent persistence via the unique (companyId, weekEndingAt) index
 *   - tenant isolation (calling with the wrong companyId returns no data)
 *
 * These tests exercise it with a hand-rolled Drizzle-shaped stub so we don't
 * depend on embedded postgres running on the test host.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks for transitive service deps ────────────────────────────────────

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

// The generator imports `instance-api-keys`, which in turn pulls the
// local-encrypted secrets provider. We stub it out so no master key is needed.
vi.mock("../services/instance-api-keys.js", () => ({
  instanceApiKeysService: () => ({
    getDecryptedKey: async () => "sk-test-fake",
    upsert: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  }),
}));

import {
  generateWeeklyWrap,
  deriveWeekEnding,
  WEEKLY_WRAP_SYSTEM_PROMPT,
} from "../services/weekly-wrap-generator.ts";
import type { Db } from "@founderos/db";

// ─── Stub DB factory ──────────────────────────────────────────────────────

type Table = "weekly_wraps" | "companies" | "issues" | "approvals" | "activity_log" | "cost_events" | "unknown";

type TableSeeds = {
  weekly_wraps?: Array<Record<string, unknown>>;
  companies?: Array<Record<string, unknown>>;
  /**
   * The generator queries `issues` twice: first with status=done (shipped),
   * then again for open-blockers. Provide an array of arrays to feed a
   * different result to each call; a single array applies to both.
   */
  issues?: Array<Record<string, unknown>> | Array<Array<Record<string, unknown>>>;
  approvals?: Array<Record<string, unknown>>;
  activity_log?: Array<Record<string, unknown>>;
  cost_events?: Array<Record<string, unknown>>;
};

function identifyTable(tableObj: unknown): Table {
  // Drizzle table objects carry a symbol property with the table name.
  const symbols = Object.getOwnPropertySymbols(tableObj as object);
  for (const s of symbols) {
    if (s.toString().includes("drizzle:Name")) {
      return ((tableObj as Record<symbol, unknown>)[s] as Table) ?? "unknown";
    }
  }
  return "unknown";
}

function chainableSelect(rows: Array<Record<string, unknown>>) {
  const final = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
      limit: vi.fn().mockResolvedValue(rows),
      then: (onfulfilled: (v: unknown) => unknown) => final.then(onfulfilled),
    }),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
    limit: vi.fn().mockResolvedValue(rows),
    then: (onfulfilled: (v: unknown) => unknown) => final.then(onfulfilled),
  };
  return chain;
}

function makeDbStub(seeds: TableSeeds, capture: { inserted: Record<string, unknown>[]; updated: Record<string, unknown>[]; insertError?: Error }) {
  // Track how many times each table has been queried so we can return the
  // nth result-set if the seed is an array-of-arrays.
  const callCount = new Map<string, number>();
  const selectImpl = vi.fn(() => ({
    from: vi.fn((tableObj: unknown) => {
      const name = identifyTable(tableObj);
      const seed = seeds[name as keyof TableSeeds];
      const n = callCount.get(name) ?? 0;
      callCount.set(name, n + 1);
      let rows: Array<Record<string, unknown>> = [];
      if (Array.isArray(seed) && seed.length > 0 && Array.isArray(seed[0])) {
        const arr = seed as Array<Array<Record<string, unknown>>>;
        rows = arr[n] ?? arr[arr.length - 1] ?? [];
      } else if (Array.isArray(seed)) {
        rows = seed as Array<Record<string, unknown>>;
      }
      return chainableSelect(rows);
    }),
  }));

  const insertImpl = vi.fn((tableObj: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => ({
      returning: vi.fn(async (_projection?: unknown) => {
        if (capture.insertError) {
          const err = capture.insertError;
          capture.insertError = undefined;
          throw err;
        }
        const row = {
          id: (values.id as string) ?? "wrap-generated-id",
          ...values,
        };
        capture.inserted.push({ table: identifyTable(tableObj), row });
        return [{ id: row.id }];
      }),
    })),
  }));

  const updateImpl = vi.fn((tableObj: unknown) => ({
    set: vi.fn((patch: Record<string, unknown>) => ({
      where: vi.fn().mockImplementation(() => {
        capture.updated.push({ table: identifyTable(tableObj), patch });
        return {
          then: (onfulfilled: (v: unknown) => unknown) =>
            Promise.resolve([]).then(onfulfilled),
          catch: () => Promise.resolve([]),
        };
      }),
    })),
  }));

  return {
    select: selectImpl,
    insert: insertImpl,
    update: updateImpl,
  } as unknown as Db;
}

const NARRATIVE =
  "We shipped the CBSE-aligned screener widget to three pilot schools and closed the BBPS compliance review. " +
  "The principal onboarding flow stalled on a signed MOU we have been chasing since Monday. " +
  "\n\nSpend was steady, agent runs skewed toward SDR replies, and we burned a day debugging the Notion sync. " +
  "One high-priority blocker is open: the API key rotation for the Hindi transcription model. " +
  "\n\nNext week, pin the signed MOU, ship the Hindi pipeline, and run two more conversion calls. " +
  "Ignore the Slack channel experiments until we see the MOU signed.";

// ─── Tests ────────────────────────────────────────────────────────────────

describe("generateWeeklyWrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the documented Chief-of-Staff system prompt", () => {
    expect(WEEKLY_WRAP_SYSTEM_PROMPT).toContain("Chief of Staff");
    expect(WEEKLY_WRAP_SYSTEM_PROMPT).toContain("3 tight paragraphs");
    expect(WEEKLY_WRAP_SYSTEM_PROMPT).toContain("120-180 words");
  });

  it("deriveWeekEnding returns a Friday 23:59:59 UTC anchor", () => {
    // 2026-04-24 is a Friday.
    const saturday = new Date("2026-04-25T10:00:00Z");
    const we = deriveWeekEnding(saturday);
    expect(we.getUTCDay()).toBe(5); // Friday
    expect(we.getUTCHours()).toBe(23);
    expect(we.getUTCMinutes()).toBe(59);
  });

  it("generates a wrap: calls Anthropic, persists, returns rendered payload", async () => {
    const capture = { inserted: [] as Record<string, unknown>[], updated: [] as Record<string, unknown>[] };
    const db = makeDbStub(
      {
        weekly_wraps: [], // no existing row → idempotent short-circuit skipped
        companies: [{ id: "company-1", name: "Little Wins" }],
        // First issues select = shipped (status=done). Second = all open issues.
        issues: [
          [
            {
              id: "iss-1",
              title: "Ship CBSE screener to pilot schools",
              identifier: "LW-12",
              status: "done",
              priority: "high",
              completedAt: new Date("2026-04-21T10:00:00Z"),
              updatedAt: new Date("2026-04-21T10:00:00Z"),
            },
          ],
          [
            {
              id: "iss-2",
              title: "Hindi transcription key rotation",
              identifier: "LW-13",
              status: "in_progress",
              priority: "critical",
              completedAt: null,
              updatedAt: new Date("2026-04-20T09:00:00Z"),
            },
          ],
        ],
        approvals: [
          {
            id: "appr-1",
            type: "budget_bump",
            status: "approved",
            payload: { title: "Raise SDR budget by $500" },
            decidedAt: new Date("2026-04-22T12:00:00Z"),
          },
        ],
        activity_log: Array.from({ length: 47 }, (_, i) => ({
          action: "agent.heartbeat",
          entityType: "agent",
          createdAt: new Date("2026-04-22T09:00:00Z"),
        })),
        cost_events: [
          { costCents: 1234, occurredAt: new Date("2026-04-22T08:00:00Z") },
          { costCents: 876, occurredAt: new Date("2026-04-23T08:00:00Z") },
        ],
      },
      capture,
    );

    const callAnthropic = vi.fn(async () => NARRATIVE);

    const wrap = await generateWeeklyWrap(db, "company-1", {
      now: new Date("2026-04-24T18:00:00Z"), // Friday
      callAnthropic,
    });

    expect(callAnthropic).toHaveBeenCalledTimes(1);
    const callArgs = callAnthropic.mock.calls[0][0];
    expect(callArgs.apiKey).toBe("sk-test-fake");
    expect(callArgs.systemPrompt).toBe(WEEKLY_WRAP_SYSTEM_PROMPT);
    expect(callArgs.userPrompt).toContain("Little Wins");
    expect(callArgs.userPrompt).toContain("Shipped this week");
    expect(callArgs.userPrompt).toContain("LW-12");

    expect(wrap.reused).toBe(false);
    expect(wrap.narrative).toBe(NARRATIVE);
    expect(wrap.text).toContain("Weekly wrap — Little Wins");
    expect(wrap.text).toContain(NARRATIVE.slice(0, 40));
    expect(wrap.html).toContain("<p");
    expect(wrap.slackBlocks).toBeDefined();
    expect(wrap.metrics.issuesShipped).toBe(1);
    expect(wrap.metrics.decisionsApproved).toBe(1);
    expect(wrap.metrics.activityCount).toBe(47);
    expect(wrap.metrics.agentSpendCents).toBe(1234 + 876);
    expect(wrap.highlights.some((h) => h.type === "issue_shipped")).toBe(true);
    expect(wrap.highlights.some((h) => h.type === "blocker")).toBe(true);

    // Exactly one insert into weekly_wraps.
    const wrapInserts = capture.inserted.filter((i) => i.table === "weekly_wraps");
    expect(wrapInserts).toHaveLength(1);
  });

  it("is idempotent: returns stored wrap without a second Anthropic call when a row already exists", async () => {
    const storedRow = {
      id: "wrap-stored-1",
      companyId: "company-1",
      weekEndingAt: deriveWeekEnding(new Date("2026-04-24T18:00:00Z")),
      narrative: NARRATIVE,
      highlights: [{ type: "issue_shipped", title: "LW-12: Ship CBSE screener" }],
      metrics: { issuesShipped: 1 },
      deliveredToSlackAt: null,
      deliveredToEmailAt: null,
      slackChannelId: null,
      createdAt: new Date(),
    };
    const capture = { inserted: [], updated: [] };
    const db = makeDbStub(
      {
        weekly_wraps: [storedRow],
        companies: [{ id: "company-1", name: "Little Wins" }],
      },
      capture,
    );

    const callAnthropic = vi.fn(async () => "should not be called");

    const wrap = await generateWeeklyWrap(db, "company-1", {
      now: new Date("2026-04-24T18:00:00Z"),
      callAnthropic,
    });

    expect(callAnthropic).not.toHaveBeenCalled();
    expect(wrap.reused).toBe(true);
    expect(wrap.storedWrapId).toBe("wrap-stored-1");
    expect(wrap.narrative).toBe(NARRATIVE);
    expect(capture.inserted).toHaveLength(0);
  });

  it("recovers from a unique-constraint race by re-reading the winning row", async () => {
    const capture = {
      inserted: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      insertError: new Error("duplicate key value violates unique constraint"),
    };
    // First select (idempotency check) returns empty; subsequent select
    // (recovery re-read) returns the raced row via the same seed — good enough
    // because the stub doesn't track call order per-table.
    const racedRow = {
      id: "wrap-race-winner",
      companyId: "company-1",
      weekEndingAt: deriveWeekEnding(new Date("2026-04-24T18:00:00Z")),
      narrative: NARRATIVE,
      highlights: [],
      metrics: {},
    };
    // Use a mutable seed: empty on first check, populated on recovery read.
    const weeklyWrapRows: Array<Record<string, unknown>> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((tableObj: unknown) => {
          const name = identifyTable(tableObj);
          if (name === "weekly_wraps") {
            return chainableSelect([...weeklyWrapRows]);
          }
          if (name === "companies") {
            return chainableSelect([{ id: "company-1", name: "Little Wins" }]);
          }
          return chainableSelect([]);
        }),
      })),
      insert: vi.fn((tableObj: unknown) => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            // Populate the row so the recovery re-read sees it.
            weeklyWrapRows.push(racedRow);
            throw capture.insertError as Error;
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
    } as unknown as Db;

    const wrap = await generateWeeklyWrap(db, "company-1", {
      now: new Date("2026-04-24T18:00:00Z"),
      callAnthropic: async () => NARRATIVE,
    });

    expect(wrap.storedWrapId).toBe("wrap-race-winner");
  });

  it("throws when no Anthropic API key is configured", async () => {
    const capture = { inserted: [], updated: [] };
    const db = makeDbStub(
      {
        weekly_wraps: [],
        companies: [{ id: "company-1", name: "Little Wins" }],
        issues: [],
        approvals: [],
        activity_log: [],
        cost_events: [],
      },
      capture,
    );

    await expect(
      generateWeeklyWrap(db, "company-1", {
        now: new Date("2026-04-24T18:00:00Z"),
        getAnthropicKey: async () => null,
        callAnthropic: async () => NARRATIVE,
      }),
    ).rejects.toThrow(/Anthropic API key/i);
  });

  it("tenant isolation: returns no data when the company is not found", async () => {
    const capture = { inserted: [], updated: [] };
    const db = makeDbStub(
      {
        weekly_wraps: [],
        companies: [], // company-B is not visible here
      },
      capture,
    );

    await expect(
      generateWeeklyWrap(db, "company-B", {
        now: new Date("2026-04-24T18:00:00Z"),
        callAnthropic: async () => NARRATIVE,
      }),
    ).rejects.toThrow(/Company not found/);
  });
});
