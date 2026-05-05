/**
 * daily-brief.test.ts — integration tests for the Daily Founder Brief (S3.3).
 *
 * Covers the spec checklist:
 *   1. Prompt unit test — buildUserPrompt is deterministic given seeded inputs
 *      and snapshots the section structure (sparse/normal mode toggle).
 *   2. Idempotency — re-running for the same (companyId, forDate) returns
 *      the existing brief, no second LLM call.
 *   3. TZ correctness — PST workspace (digestTimezone='America/Los_Angeles')
 *      and IST workspace ('Asia/Kolkata') each fire at their LOCAL 7am
 *      (drives forDate selection in isoDateInTimezone).
 *   4. Empty workspace — welcome brief generated, no LLM call invoked.
 *   5. Fallback — malformed JSON from LLM produces a synthesized brief
 *      AND writes a kind='blocker' insight so the founder sees the hiccup.
 *
 * Real embedded Postgres so the unique index, FK CASCADE, and the daily-
 * briefs CHECK-free schema are exercised against the real DDL. We mock
 * the LLM call deterministically — no network, no Anthropic SDK choices.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  createDb,
  dailyBriefs,
  insights,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildUserPrompt,
  DAILY_BRIEF_SYSTEM_PROMPT,
  dailyBriefPayloadSchema,
  extractJsonObject,
  generateDailyBrief,
  isEmptyWorkspace,
  SPARSE_DATA_THRESHOLD,
  synthesizeFallbackBrief,
  type AnthropicJsonCaller,
  type BriefInputs,
  type DailyBriefPayloadParsed,
} from "../services/cos/brief-prompt.js";
import {
  generateDailyBriefForCompany,
  isoDateInTimezone,
} from "../jobs/daily-founder-brief.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping daily-brief tests: ${support.reason ?? "unsupported environment"}`,
  );
}

// ── Pure unit tests (no DB) ─────────────────────────────────────────────────

describe("daily-brief: prompt + parsing (pure unit)", () => {
  const seedInputs: BriefInputs = {
    companyName: "Little Wins",
    forDate: new Date("2026-04-22T00:00:00.000Z"),
    kpiSnapshots: [
      { metric: "MRR", from: "$10,000", to: "$11,400", delta: "+14%" },
      { metric: "Trial conversions", from: "12", to: "18", delta: "+50%" },
    ],
    openInsights: [
      {
        id: "ins-1",
        kind: "kpi_anomaly",
        title: "Activation drop at step 2",
        body: "Signup → first session has dropped 22% week over week.",
        confidence: 0.82,
        recommendation: "Audit step-2 onboarding copy + shipping email open rate.",
      },
    ],
    pendingApprovals: [
      {
        id: "appr-1",
        type: "budget_bump",
        title: "Raise SDR budget by $500",
        createdAt: new Date("2026-04-21T08:00:00Z"),
      },
    ],
    stalledWorkflows: [
      { id: "iss-1", title: "Hindi transcription key rotation", stalledFor: "3 days" },
    ],
    topOpportunities: [
      {
        id: "ins-opp-1",
        kind: "opportunity",
        title: "LinkedIn referral funnel",
        body: "Referral from LinkedIn beats paid by 4x on signup-to-trial.",
        confidence: 0.88,
        recommendation: "Bump LinkedIn organic budget by 20%.",
      },
    ],
    eventCount: 412,
  };

  it("system prompt enforces JSON-only and tone discipline", () => {
    expect(DAILY_BRIEF_SYSTEM_PROMPT).toContain("Chief of Staff");
    expect(DAILY_BRIEF_SYSTEM_PROMPT).toContain("ONLY a JSON object");
    expect(DAILY_BRIEF_SYSTEM_PROMPT).toContain("EXACTLY 3 topThreeActions");
    expect(DAILY_BRIEF_SYSTEM_PROMPT).toContain("Limited data —");
  });

  it("buildUserPrompt is deterministic and contains expected sections", () => {
    const a = buildUserPrompt(seedInputs);
    const b = buildUserPrompt(seedInputs);
    expect(a).toBe(b);

    expect(a).toContain("Company: Little Wins");
    expect(a).toContain("KPI snapshots");
    expect(a).toContain("MRR: $10,000 → $11,400 (+14%)");
    expect(a).toContain("Open insights last 24h (1)");
    expect(a).toContain("[id=ins-1]");
    expect(a).toContain("[approvalId=appr-1]");
    expect(a).toContain("Stalled workflows (1)");
    expect(a).toContain("Top opportunities (1)");
    // Normal mode — no sparse marker.
    expect(a).toContain("Signal volume: NORMAL (412 events)");
  });

  it("buildUserPrompt switches to sparse mode below threshold", () => {
    const sparse = buildUserPrompt({ ...seedInputs, eventCount: 5 });
    expect(sparse).toContain("SPARSE");
    expect(sparse).toContain("Limited data —");
    // Sanity: threshold constant is exposed for tests.
    expect(SPARSE_DATA_THRESHOLD).toBeGreaterThan(5);
  });

  it("extractJsonObject handles fenced and unfenced LLM output", () => {
    const fenced = "```json\n{\"a\":1}\n```";
    expect(extractJsonObject(fenced)).toEqual({ a: 1 });
    const noisy = "Sure, here's the brief:\n{\"a\":2}\nLet me know!";
    expect(extractJsonObject(noisy)).toEqual({ a: 2 });
    expect(() => extractJsonObject("no json here")).toThrow();
  });

  it("dailyBriefPayloadSchema rejects 2-action output and accepts the canonical 3", () => {
    const valid: DailyBriefPayloadParsed = {
      headline: "MRR up 14%; activation drop at step 2 needs attention.",
      kpiMovements: [
        {
          metric: "MRR",
          from: "$10,000",
          to: "$11,400",
          delta: "+14%",
          commentary: "LinkedIn-driven trial conversions are converting.",
        },
      ],
      anomalies: [{ title: "Activation drop", insightId: "ins-1" }],
      blockers: [{ title: "Hindi transcription", resolutionAction: "Rotate key" }],
      opportunities: [
        {
          title: "LinkedIn referral",
          expectedImpact: "20% lift",
          insightId: "ins-opp-1",
        },
      ],
      topThreeActions: [
        {
          action: "Approve SDR budget bump",
          rationale: "Unblocks two stalled experiments.",
          approvalId: "appr-1",
        },
        {
          action: "Audit step-2 onboarding copy",
          rationale: "Activation drop is the highest-leverage fix this week.",
        },
        {
          action: "Bump LinkedIn organic by 20%",
          rationale: "4x signup-to-trial vs. paid.",
        },
      ],
    };
    expect(dailyBriefPayloadSchema.safeParse(valid).success).toBe(true);

    const tooFew = { ...valid, topThreeActions: valid.topThreeActions.slice(0, 2) };
    expect(dailyBriefPayloadSchema.safeParse(tooFew).success).toBe(false);

    const tooMany = {
      ...valid,
      topThreeActions: [...valid.topThreeActions, valid.topThreeActions[0]!],
    };
    expect(dailyBriefPayloadSchema.safeParse(tooMany).success).toBe(false);
  });

  it("generateDailyBrief: clean LLM output → ok=true, source=llm", async () => {
    const validPayload = canonicalPayload();
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(validPayload),
    );

    const result = await generateDailyBrief(seedInputs, {
      apiKey: "sk-test",
      callAnthropic,
    });

    expect(callAnthropic).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("llm");
    expect(result.payload.headline).toBe(validPayload.headline);
    expect(result.payload.topThreeActions).toHaveLength(3);
  });

  it("generateDailyBrief: malformed JSON → ok=false, source=fallback (synthesized)", async () => {
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => "not json at all");

    const result = await generateDailyBrief(seedInputs, {
      apiKey: "sk-test",
      callAnthropic,
    });

    expect(result.ok).toBe(false);
    expect(result.source).toBe("fallback");
    // Fallback always produces exactly 3 actions to satisfy the schema.
    expect(result.payload.topThreeActions).toHaveLength(3);
    // Synthesized brief surfaces the failure as a blocker entry.
    expect(
      result.payload.blockers.some((b) =>
        b.title.includes("synthesized without LLM"),
      ),
    ).toBe(true);
  });

  it("generateDailyBrief: schema-failed JSON (2 actions) → fallback fires", async () => {
    const broken = canonicalPayload();
    broken.topThreeActions = broken.topThreeActions.slice(0, 2);
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(broken),
    );

    const result = await generateDailyBrief(seedInputs, {
      apiKey: "sk-test",
      callAnthropic,
    });
    expect(result.ok).toBe(false);
    expect(result.source).toBe("fallback");
  });

  it("synthesizeFallbackBrief always produces 3 actions even with empty inputs", () => {
    const empty: BriefInputs = {
      companyName: "X",
      forDate: new Date("2026-04-22T00:00:00.000Z"),
      kpiSnapshots: [],
      openInsights: [],
      pendingApprovals: [],
      stalledWorkflows: [],
      topOpportunities: [],
      eventCount: 0,
    };
    const fb = synthesizeFallbackBrief(empty, "test reason");
    expect(fb.topThreeActions).toHaveLength(3);
    // Empty inputs are detected as empty-workspace, but the fallback path
    // is still safe to invoke directly.
    expect(isEmptyWorkspace(empty)).toBe(true);
  });
});

// ── Date-utility unit tests ─────────────────────────────────────────────────

describe("daily-brief: timezone date math", () => {
  it("isoDateInTimezone returns yyyy-mm-dd in America/Los_Angeles", () => {
    // 2026-04-22 07:00 UTC = 2026-04-22 00:00 PDT (UTC-7)
    const d = new Date("2026-04-22T07:00:00Z");
    expect(isoDateInTimezone(d, "America/Los_Angeles")).toBe("2026-04-22");
    // 2026-04-22 06:00 UTC = 2026-04-21 23:00 PDT — date rolls back.
    const earlier = new Date("2026-04-22T06:00:00Z");
    expect(isoDateInTimezone(earlier, "America/Los_Angeles")).toBe("2026-04-21");
  });

  it("isoDateInTimezone returns yyyy-mm-dd in Asia/Kolkata (IST UTC+5:30)", () => {
    // 2026-04-22 18:30 UTC = 2026-04-23 00:00 IST
    const d = new Date("2026-04-22T18:30:00Z");
    expect(isoDateInTimezone(d, "Asia/Kolkata")).toBe("2026-04-23");
  });
});

// ── DB-backed integration tests (idempotency, TZ, empty-workspace, fallback) ─

describeEmbeddedPostgres("daily-brief: full flow against embedded postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("daily-brief");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes daily_briefs + insights + memberships via FK.
    await db.execute(sql`TRUNCATE TABLE "daily_briefs" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "company_memberships" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
  });

  async function seedCompany(
    name: string,
    tz = "UTC",
  ): Promise<string> {
    const [c] = await db
      .insert(companies)
      .values({ name })
      .returning({ id: companies.id });
    const companyId = c!.id;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: `user-${name}`,
      status: "active",
      digestTimezone: tz,
    });
    return companyId;
  }

  it("empty workspace → welcome brief, no LLM call", async () => {
    const companyId = await seedCompany("EmptyCo", "UTC");
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => "should not be called");

    const r = await generateDailyBriefForCompany(db, companyId, {
      now: new Date("2026-04-22T07:00:00Z"),
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(callAnthropic).not.toHaveBeenCalled();
    expect(r.source).toBe("welcome");
    expect(r.reused).toBe(false);
    expect(r.brief.payload.headline).toContain("Welcome to EmptyCo");
    expect(r.brief.payload.topThreeActions).toHaveLength(3);
  });

  it("idempotent — re-run returns existing brief, no second LLM call", async () => {
    const companyId = await seedCompany("IdempotentCo", "UTC");
    const llmCalls: number[] = [];
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => {
      llmCalls.push(Date.now());
      return JSON.stringify(canonicalPayload());
    });

    // Force non-empty signal so the LLM path triggers (insert an open insight).
    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "opportunity",
      title: "LinkedIn referral lift",
      body: "Referral from LinkedIn beats paid by 4x.",
      confidence: 0.88,
      recommendation: "Bump LI organic by 20%.",
      evidence: {},
    });

    const now = new Date("2026-04-22T07:00:00Z");
    const r1 = await generateDailyBriefForCompany(db, companyId, {
      now,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    expect(r1.reused).toBe(false);
    expect(llmCalls).toHaveLength(1);

    const r2 = await generateDailyBriefForCompany(db, companyId, {
      now,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    expect(r2.reused).toBe(true);
    expect(r2.brief.id).toBe(r1.brief.id);
    expect(llmCalls).toHaveLength(1); // still 1 — no second LLM call
  });

  it("PST workspace fires 2026-04-22 forDate at 14:00 UTC (07:00 PDT)", async () => {
    const companyId = await seedCompany("WestCo", "America/Los_Angeles");
    // Seed minimal signal so we don't hit the welcome-brief path.
    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "opportunity",
      title: "x",
      body: "x",
      confidence: 0.8,
      evidence: {},
    });
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalPayload()),
    );

    // 2026-04-22 14:00 UTC = 07:00 PDT (UTC-7 in April).
    const now = new Date("2026-04-22T14:00:00Z");
    const r = await generateDailyBriefForCompany(db, companyId, {
      now,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    // forDate is the LOCAL date in PDT — 2026-04-22.
    const forDateString =
      r.brief.forDate instanceof Date
        ? r.brief.forDate.toISOString().slice(0, 10)
        : String(r.brief.forDate);
    expect(forDateString).toBe("2026-04-22");
  });

  it("IST workspace fires 2026-04-23 forDate at 01:30 UTC (07:00 IST)", async () => {
    const companyId = await seedCompany("EastCo", "Asia/Kolkata");
    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "opportunity",
      title: "x",
      body: "x",
      confidence: 0.8,
      evidence: {},
    });
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify(canonicalPayload()),
    );

    // 2026-04-23 01:30 UTC = 07:00 IST (UTC+5:30).
    const now = new Date("2026-04-23T01:30:00Z");
    const r = await generateDailyBriefForCompany(db, companyId, {
      now,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    const forDateString =
      r.brief.forDate instanceof Date
        ? r.brief.forDate.toISOString().slice(0, 10)
        : String(r.brief.forDate);
    expect(forDateString).toBe("2026-04-23");
  });

  it("malformed LLM JSON → fallback brief AND blocker insight written", async () => {
    const companyId = await seedCompany("FallbackCo", "UTC");
    // Need non-empty signal to bypass welcome path.
    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "kpi_anomaly",
      title: "Daily activations dropped",
      body: "Signups halved overnight.",
      confidence: 0.9,
      evidence: {},
    });
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => "not parseable JSON");

    const r = await generateDailyBriefForCompany(db, companyId, {
      now: new Date("2026-04-22T07:00:00Z"),
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(r.source).toBe("fallback");
    expect(r.brief.payload.topThreeActions).toHaveLength(3);

    // Allow async fire-and-forget insert to land — the test is fast enough
    // that the insert should complete before the next read in v8 microtask
    // ordering, but we await briefly to be safe.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const blockerRows = await db
      .select()
      .from(insights)
      .where(sql`${insights.companyId} = ${companyId} AND ${insights.kind} = 'blocker'`);
    expect(blockerRows.length).toBeGreaterThanOrEqual(1);
    expect(blockerRows[0]!.title).toContain("synthesized without LLM");
  });

  it("missing API key → fallback brief AND blocker insight (no throw)", async () => {
    const companyId = await seedCompany("NoKeyCo", "UTC");
    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "opportunity",
      title: "x",
      body: "x",
      confidence: 0.8,
      evidence: {},
    });

    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => "should not be called");
    const r = await generateDailyBriefForCompany(db, companyId, {
      now: new Date("2026-04-22T07:00:00Z"),
      callAnthropic,
      getAnthropicKey: async () => null,
    });
    expect(callAnthropic).not.toHaveBeenCalled();
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toContain("Anthropic API key");
  });

  it("throws when company not found", async () => {
    await expect(
      generateDailyBriefForCompany(db, "00000000-0000-0000-0000-000000000000", {
        now: new Date("2026-04-22T07:00:00Z"),
        callAnthropic: vi.fn(async () => JSON.stringify(canonicalPayload())),
        getAnthropicKey: async () => "sk-test",
      }),
    ).rejects.toThrow(/Company not found/);
  });
});

// ── Test helper — canonical valid payload ───────────────────────────────────

function canonicalPayload(): DailyBriefPayloadParsed {
  return {
    headline:
      "MRR up 14% on LinkedIn-driven trial conversions; activation drop at step 2 needs attention.",
    kpiMovements: [
      {
        metric: "MRR",
        from: "$10,000",
        to: "$11,400",
        delta: "+14%",
        commentary: "LinkedIn-driven trial conversions doing the heavy lifting.",
      },
    ],
    anomalies: [
      { title: "Activation drop at step 2", insightId: "ins-1" },
    ],
    blockers: [
      {
        title: "Hindi transcription key rotation",
        resolutionAction: "Rotate the API key and redeploy worker.",
      },
    ],
    opportunities: [
      {
        title: "LinkedIn referral funnel",
        expectedImpact: "Estimated 20% lift on signup-to-trial.",
        insightId: "ins-opp-1",
      },
    ],
    topThreeActions: [
      {
        action: "Approve SDR budget bump",
        rationale: "Unblocks two stalled experiments tracked in Approvals.",
        approvalId: "appr-1",
      },
      {
        action: "Audit step-2 onboarding copy",
        rationale: "Highest-leverage fix this week per the activation anomaly.",
      },
      {
        action: "Bump LinkedIn organic budget by 20%",
        rationale: "Referral channel beats paid by 4x on signup-to-trial.",
      },
    ],
  };
}
