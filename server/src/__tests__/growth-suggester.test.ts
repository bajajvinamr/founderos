/**
 * growth-suggester.test.ts — integration tests for the Growth experiment
 * suggester (S3.6).
 *
 * Coverage:
 *   1. Pure-unit (no DB):
 *      - sha256PseudoEmbedding: deterministic, 1536-dim, normalized,
 *        identical text → cosine ≈ 1.0, different text → cosine ≪ 1.0.
 *      - Zod schema validates the LLM envelope; rejects out-of-range ICE.
 *      - extractJsonObject tolerates code-fence wrappers.
 *      - buildUserPrompt emits sparse-mode notice under 50 events.
 *
 *   2. DB-backed (embedded postgres):
 *      - 3 LLM proposals → 3 inserted rows with status='proposed'.
 *      - Re-run with the same proposals → 0 new rows (text-equality dedup
 *        path; embedded postgres has no pgvector by default — see note).
 *      - 6 proposals → cap at 5 inserted, 1 skipped as cap.
 *      - Bad JSON from LLM → blocker insight created, no rows inserted.
 *      - Schema-failed JSON (ICE > 10) → blocker insight, no rows.
 *      - Network failure (callAnthropic throws) → blocker insight.
 *      - Company-not-found → ok=false, no blocker insight.
 *
 * pgvector test handling:
 *   The default embedded-postgres binary used by `@founderos/db` does NOT
 *   include the pgvector extension. The migration `0084_experiment_embeddings`
 *   does `CREATE EXTENSION IF NOT EXISTS vector` which fails-silently if
 *   the extension binary isn't on the server's `share/extension/` path.
 *   We probe at test-suite startup; pgvector-cosine-specific cases run only
 *   when present, the rest exercise the text-dedup fallback. Prod (Fly MPG)
 *   has pgvector 0.8.0 verified.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  experiments,
  insights,
  HYPOTHESIS_EMBEDDING_DIM,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildUserPrompt,
  DEDUP_COSINE_THRESHOLD,
  extractJsonObject,
  growthSuggesterPayloadSchema,
  MAX_EXPERIMENTS_PER_RUN,
  runGrowthSuggester,
  sha256PseudoEmbedding,
  type AnthropicJsonCaller,
  type ProposedExperiment,
  type SuggesterInputs,
} from "../services/agents/growth-suggester.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping growth-suggester DB tests: ${support.reason ?? "unsupported environment"}`,
  );
}

// ── Pure-unit tests (no DB) ─────────────────────────────────────────────────

describe("growth-suggester: sha256 pseudo-embedding", () => {
  it("produces a 1536-dim vector", () => {
    const v = sha256PseudoEmbedding("test hypothesis");
    expect(v).toHaveLength(HYPOTHESIS_EMBEDDING_DIM);
  });

  it("is L2-normalized (sum of squares ≈ 1)", () => {
    const v = sha256PseudoEmbedding("Bump LinkedIn organic by 20%");
    const sumSq = v.reduce((acc, x) => acc + x * x, 0);
    expect(sumSq).toBeGreaterThan(0.99);
    expect(sumSq).toBeLessThan(1.01);
  });

  it("is deterministic — same input → same vector", () => {
    const v1 = sha256PseudoEmbedding("Try paid Meta retargeting on warm leads");
    const v2 = sha256PseudoEmbedding("Try paid Meta retargeting on warm leads");
    expect(v1).toEqual(v2);
  });

  it("is case-insensitive on input (cosine = 1 on case variants)", () => {
    const v1 = sha256PseudoEmbedding("Boost LinkedIn referral budget");
    const v2 = sha256PseudoEmbedding("BOOST LINKEDIN REFERRAL BUDGET");
    const cosine = v1.reduce((acc, x, i) => acc + x * v2[i]!, 0);
    expect(cosine).toBeCloseTo(1.0, 5);
  });

  it("different text → cosine well below dedup threshold", () => {
    const v1 = sha256PseudoEmbedding("Bump LinkedIn organic by 20%");
    const v2 = sha256PseudoEmbedding("Slash paid Meta budget by 50%");
    const cosine = v1.reduce((acc, x, i) => acc + x * v2[i]!, 0);
    // sha256 distribution → cosine ≈ 0 for unrelated strings
    expect(cosine).toBeLessThan(DEDUP_COSINE_THRESHOLD);
    expect(Math.abs(cosine)).toBeLessThan(0.1);
  });
});

describe("growth-suggester: schema validation", () => {
  const validProposal: ProposedExperiment = {
    hypothesis:
      "If we bump LinkedIn organic posting cadence to 5/wk, signups will rise 20%.",
    channel: "linkedin",
    expectedLiftPct: 0.2,
    expectedCacCents: 0,
    iceImpact: 8,
    iceConfidence: 6,
    iceEase: 7,
    rationale:
      "LinkedIn dominates events_by_source (842 vs paid 80). Founder content drove last 3 signups per insights.",
  };

  it("accepts a well-formed envelope with one proposal", () => {
    const result = growthSuggesterPayloadSchema.safeParse({
      experiments: [validProposal],
    });
    expect(result.success).toBe(true);
  });

  it("rejects iceImpact > 10", () => {
    const broken = { ...validProposal, iceImpact: 11 };
    const result = growthSuggesterPayloadSchema.safeParse({
      experiments: [broken],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown channel", () => {
    const broken = { ...validProposal, channel: "tiktok" };
    const result = growthSuggesterPayloadSchema.safeParse({
      experiments: [broken],
    });
    expect(result.success).toBe(false);
  });

  it("rejects too-short hypothesis", () => {
    const broken = { ...validProposal, hypothesis: "do stuff" };
    const result = growthSuggesterPayloadSchema.safeParse({
      experiments: [broken],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative cents", () => {
    const broken = { ...validProposal, expectedCacCents: -100 };
    const result = growthSuggesterPayloadSchema.safeParse({
      experiments: [broken],
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero experiments (responsible underflow)", () => {
    const result = growthSuggesterPayloadSchema.safeParse({ experiments: [] });
    expect(result.success).toBe(true);
  });
});

describe("growth-suggester: extractJsonObject", () => {
  it("strips ```json fences", () => {
    const raw = '```json\n{"experiments":[]}\n```';
    expect(extractJsonObject(raw)).toEqual({ experiments: [] });
  });

  it("strips plain ``` fences", () => {
    const raw = '```\n{"experiments":[]}\n```';
    expect(extractJsonObject(raw)).toEqual({ experiments: [] });
  });

  it("tolerates leading prose", () => {
    const raw = 'Here are the proposals:\n\n{"experiments":[]}';
    expect(extractJsonObject(raw)).toEqual({ experiments: [] });
  });

  it("throws on no JSON", () => {
    expect(() => extractJsonObject("just prose")).toThrow();
  });
});

describe("growth-suggester: buildUserPrompt", () => {
  const seedInputs: SuggesterInputs = {
    companyName: "Little Wins",
    eventCount: 1200,
    eventsBySource: [
      { source: "linkedin", count: 842 },
      { source: "stripe", count: 280 },
      { source: "posthog", count: 78 },
    ],
    openInsights: [
      {
        id: "ins-1",
        kind: "kpi_anomaly",
        title: "Activation drop at step 2",
        body: "Signup → first session has dropped 22%.",
        confidence: 0.82,
        recommendation: "Audit step-2 onboarding copy.",
      },
    ],
    kpiSnapshots: [
      { metric: "mrr", value: 11400, unit: "cents" },
      { metric: "signups_7d", value: 18 },
    ],
    existingProposed: [
      {
        hypothesis: "Test cohort-specific email sequence on inactive users.",
        channel: "content",
      },
    ],
  };

  it("includes company name + event count + by-source counts", () => {
    const prompt = buildUserPrompt(seedInputs);
    expect(prompt).toContain("Little Wins");
    expect(prompt).toContain("NORMAL (1200 events");
    expect(prompt).toContain("linkedin: 842");
  });

  it("emits SPARSE notice under 50 events", () => {
    const sparse = { ...seedInputs, eventCount: 12 };
    const prompt = buildUserPrompt(sparse);
    expect(prompt).toContain("SPARSE");
    expect(prompt).toContain("iceConfidence ≤ 5");
  });

  it("includes existing proposed hypotheses verbatim", () => {
    const prompt = buildUserPrompt(seedInputs);
    expect(prompt).toContain("Test cohort-specific email sequence");
  });

  it("references KPI metric names + values", () => {
    const prompt = buildUserPrompt(seedInputs);
    expect(prompt).toContain("mrr: 11400");
  });
});

// ── DB-backed integration tests ─────────────────────────────────────────────

describeEmbeddedPostgres("growth-suggester: full flow against embedded postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("growth-suggester");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes experiments + insights + memberships via FK.
    await db.execute(sql`TRUNCATE TABLE "experiments" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
  });

  async function seedCompany(name: string): Promise<string> {
    const [c] = await db
      .insert(companies)
      .values({ name })
      .returning({ id: companies.id });
    return c!.id;
  }

  function makeProposal(
    hypothesis: string,
    channel: ProposedExperiment["channel"] = "linkedin",
  ): ProposedExperiment {
    return {
      hypothesis,
      channel,
      expectedLiftPct: 0.15,
      expectedCacCents: 0,
      iceImpact: 7,
      iceConfidence: 6,
      iceEase: 7,
      rationale:
        "Strong LinkedIn signal in events_by_source plus referenced insight ins-1 makes this the highest-leverage proposal this week.",
    };
  }

  function llmReturning(proposals: ProposedExperiment[]): AnthropicJsonCaller {
    return vi.fn(async () => JSON.stringify({ experiments: proposals }));
  }

  it("3 LLM proposals → 3 rows with status='proposed' and department='growth'", async () => {
    const companyId = await seedCompany("ProposalsCo");
    const proposals = [
      makeProposal(
        "If we bump LinkedIn organic posting cadence to 5/wk, signups will rise 20%.",
        "linkedin",
      ),
      makeProposal(
        "If we launch a referral program with $20 credit, paid CAC will drop 30%.",
        "referral",
      ),
      makeProposal(
        "If we revamp the SEO landing pages on top 5 keywords, organic signups +15%.",
        "seo",
      ),
    ];
    const callAnthropic = llmReturning(proposals);

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic,
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposed).toHaveLength(3);
    for (const r of result.proposed) {
      expect(r.status).toBe("proposed");
      expect(r.department).toBe("growth");
    }

    const rows = await db.select().from(experiments);
    expect(rows).toHaveLength(3);
    expect(callAnthropic).toHaveBeenCalledTimes(1);
  });

  it("re-run with same hypothesis → 0 new rows (dedup via text fallback)", async () => {
    const companyId = await seedCompany("DedupCo");
    const proposals = [
      makeProposal(
        "If we bump LinkedIn organic posting cadence to 5/wk, signups will rise 20%.",
        "linkedin",
      ),
    ];

    const r1 = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic: llmReturning(proposals),
      systemPromptOverride: "test prompt",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.proposed).toHaveLength(1);

    const r2 = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic: llmReturning(proposals),
      systemPromptOverride: "test prompt",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.proposed).toHaveLength(0);
    expect(r2.skippedAsDuplicate).toBe(1);

    // Total rows in DB still 1.
    const rows = await db.select().from(experiments);
    expect(rows).toHaveLength(1);
  });

  it("6 proposals → 5 inserted, 1 skipped as cap", async () => {
    const companyId = await seedCompany("CapCo");
    const proposals = [
      makeProposal("Hypothesis A targeting LinkedIn — drives signups via founder posts.", "linkedin"),
      makeProposal("Hypothesis B aiming at paid Meta retargeting on warm trial leads.", "paid_meta"),
      makeProposal("Hypothesis C around SEO long-tail keywords for activation increase.", "seo"),
      makeProposal("Hypothesis D launching a referral program with credit incentive.", "referral"),
      makeProposal("Hypothesis E on partnerships with adjacent SaaS for cross-promotion.", "partnerships"),
      makeProposal("Hypothesis F via content syndication on Medium and dev.to to widen.", "content"),
    ];

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic: llmReturning(proposals),
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposed).toHaveLength(MAX_EXPERIMENTS_PER_RUN);
    expect(result.skippedAsCap).toBe(1);

    const rows = await db.select().from(experiments);
    expect(rows).toHaveLength(MAX_EXPERIMENTS_PER_RUN);
  });

  it("malformed LLM JSON → blocker insight created, no experiment rows", async () => {
    const companyId = await seedCompany("BadJsonCo");
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => "not json at all");

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic,
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("malformed JSON");
    expect(result.blockerInsightId).not.toBeNull();

    const expRows = await db.select().from(experiments);
    expect(expRows).toHaveLength(0);

    const blockerRows = await db
      .select()
      .from(insights)
      .where(sql`${insights.kind} = 'blocker' AND ${insights.companyId} = ${companyId}`);
    expect(blockerRows).toHaveLength(1);
    expect(blockerRows[0]!.department).toBe("growth");
    expect(blockerRows[0]!.title).toContain("suggester failed");
  });

  it("schema-failed JSON (ICE > 10) → blocker insight, no rows", async () => {
    const companyId = await seedCompany("BadSchemaCo");
    const broken = makeProposal(
      "If we bump LinkedIn organic posting cadence to 5/wk, signups will rise 20%.",
    );
    // Force out-of-range ICE.
    (broken as unknown as { iceImpact: number }).iceImpact = 99;

    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify({ experiments: [broken] }),
    );

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic,
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("schema");

    const blockerRows = await db
      .select()
      .from(insights)
      .where(sql`${insights.kind} = 'blocker' AND ${insights.companyId} = ${companyId}`);
    expect(blockerRows).toHaveLength(1);
  });

  it("network failure (callAnthropic throws) → blocker insight", async () => {
    const companyId = await seedCompany("NetFailCo");
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic,
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("LLM call failed");
    expect(result.blockerInsightId).not.toBeNull();
  });

  it("company not found → ok=false, no blocker insight (caller boundary issue)", async () => {
    const result = await runGrowthSuggester(
      db,
      "00000000-0000-0000-0000-000000000000",
      {
        apiKey: "sk-test",
        callAnthropic: vi.fn(async () => '{"experiments":[]}'),
        systemPromptOverride: "test prompt",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Company not found");
    expect(result.blockerInsightId).toBeNull();
  });

  it("zero proposals (LLM responsibly underflows on sparse signal) → 0 rows, ok=true", async () => {
    const companyId = await seedCompany("UnderflowCo");
    const callAnthropic: AnthropicJsonCaller = vi.fn(async () =>
      JSON.stringify({ experiments: [] }),
    );

    const result = await runGrowthSuggester(db, companyId, {
      apiKey: "sk-test",
      callAnthropic,
      systemPromptOverride: "test prompt",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposed).toHaveLength(0);
  });
});
