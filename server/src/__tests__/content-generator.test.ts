/**
 * content-generator.test.ts — integration + unit tests for S4.2.
 *
 * Test categories:
 *
 *   A. Service unit tests (no DB) — 5 tests
 *      A1. buildUserPrompt includes title, thesis, audience, angle, keywords
 *      A2. buildUserPrompt excludes nulls gracefully
 *      A3. buildUserPrompt truncates notesMarkdown at 2000 chars (no PII bleed)
 *      A4. extractJsonObject strips markdown fences
 *      A5. generatedContentSchema rejects missing top-level keys
 *
 *   B. Happy-path integration — 4 tests (embedded Postgres)
 *      B1. brief → 6 drafts created (one per format)
 *      B2. re-generation on same brief → overwrites drafts (latest-wins, not append)
 *      B3. brief status transitions to 'review' after successful generation
 *      B4. audit log row emits workflowId when provided
 *
 *   C. Tenant isolation — 2 tests (embedded Postgres)
 *      C1. brief belongs to other company → ok:false, no drafts written
 *      C2. GET /content-drafts/:draftId with wrong company → 404
 *
 *   D. LLM failure path — 2 tests (embedded Postgres)
 *      D1. LLM call throws → result ok:false + error drafts written with generationError
 *      D2. LLM returns malformed JSON → result ok:false + error drafts written
 *
 *   E. Route-level tests — 5 tests (embedded Postgres + supertest)
 *      E1. POST /generate returns 422 when no API key in env
 *      E2. GET /content-drafts returns list scoped to company
 *      E3. GET /content-drafts?briefId= filters correctly
 *      E4. GET /content-drafts?format= filters correctly
 *      E5. PATCH /content-drafts/:id updates status + sets publishedAt on 'published'
 *
 *   F. DB-level CHECK constraints — 2 tests (embedded Postgres)
 *      F1. INSERT with invalid format → throws (CHECK constraint)
 *      F2. INSERT with invalid status → throws (CHECK constraint)
 *
 * Total: 20 tests.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, and, eq } from "drizzle-orm";
import {
  companies,
  contentBriefs,
  contentDrafts,
  activityLog,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contentDraftRoutes } from "../routes/content-drafts.js";
import { errorHandler } from "../middleware/index.js";
import {
  buildUserPrompt,
  extractJsonObject,
  generatedContentSchema,
  runContentGenerator,
  type GeneratedContent,
  type AnthropicCaller,
} from "../services/agents/content-generator.js";

// ── Embedded Postgres gating ─────────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping content-generator DB tests: ${support.reason ?? "unsupported environment"}`,
  );
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Minimal valid LLM response envelope covering all 6 formats. */
function makeValidLlmResponse(): GeneratedContent {
  return {
    linkedinPost: {
      body: "Great onboarding matters for SaaS founders.",
      hashtagSuggestions: ["saas", "onboarding"],
      estimatedReadTime: 2,
    },
    xThread: {
      tweets: ["Hook tweet", "Point 1", "Point 2", "Conclusion"],
      commentary: "Thread arc: hook, evidence, CTA.",
    },
    newsletter: {
      subject: "The onboarding mistake costing you 20% MRR",
      body: "# Introduction\n\nYour onboarding matters more than you think...",
    },
    reelScript: {
      hook: "Your onboarding is losing you customers right now.",
      valueBeats: ["Beat 1: identify the drop", "Beat 2: fix the moment"],
      cta: "Download the checklist",
      runtime: "60s",
    },
    landingCopy: {
      headline: "Ship onboarding that converts",
      subheadline: "Turn new signups into activated power users in under 7 days.",
      bullets: ["Reduce time-to-value", "Lower churn in week 1"],
      cta: "Start free",
    },
    adCreative: {
      primaryText: "Most SaaS founders lose 30% of signups in week 1.",
      headline: "Fix onboarding today",
      description: "Join 500+ founders who did.",
    },
  };
}

function stubCaller(response: GeneratedContent): AnthropicCaller {
  return async () => JSON.stringify(response);
}

function failingCaller(message = "HTTP 529"): AnthropicCaller {
  return async () => {
    throw new Error(message);
  };
}

function malformedCaller(): AnthropicCaller {
  return async () => "not json at all";
}

// ── A. Service unit tests (no DB) ─────────────────────────────────────────────

describe("buildUserPrompt", () => {
  it("A1: includes title, thesis, audience, angle, keywords", () => {
    const prompt = buildUserPrompt({
      title: "My title",
      thesis: "My thesis",
      audience: "SaaS founders",
      angle: "how-to",
      keywords: ["activation", "onboarding"],
      notesMarkdown: null,
    });
    expect(prompt).toContain("My title");
    expect(prompt).toContain("My thesis");
    expect(prompt).toContain("SaaS founders");
    expect(prompt).toContain("how-to");
    expect(prompt).toContain("activation");
    expect(prompt).toContain("onboarding");
  });

  it("A2: handles null optional fields gracefully", () => {
    const prompt = buildUserPrompt({
      title: "T",
      thesis: "Thesis",
      audience: null,
      angle: null,
      keywords: null,
      notesMarkdown: null,
    });
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  it("A3: truncates notesMarkdown at 2000 chars", () => {
    const longNote = "x".repeat(5000);
    const prompt = buildUserPrompt({
      title: "T",
      thesis: "Thesis",
      audience: null,
      angle: null,
      keywords: null,
      notesMarkdown: longNote,
    });
    // The notes section appears in the prompt but capped at 2000 chars of the note.
    expect(prompt).toContain("x".repeat(2000));
    expect(prompt).not.toContain("x".repeat(2001));
  });
});

describe("extractJsonObject", () => {
  it("A4: strips markdown fences and returns parsed object", () => {
    const raw = "```json\n{\"foo\": 1}\n```";
    const result = extractJsonObject(raw) as { foo: number };
    expect(result.foo).toBe(1);
  });
});

describe("generatedContentSchema", () => {
  it("A5: rejects payload missing top-level keys", () => {
    const result = generatedContentSchema.safeParse({ linkedinPost: {} });
    expect(result.success).toBe(false);
  });
});

// ── B-F: DB-backed tests ──────────────────────────────────────────────────────

describeEmbeddedPostgres("Content Generator — DB tests", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;
  let briefId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-content-gen-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [c1] = await db
      .insert(companies)
      .values({ name: "Acme Corp", issuePrefix: "ACM" })
      .returning({ id: companies.id });
    companyId = c1!.id;

    const [c2] = await db
      .insert(companies)
      .values({ name: "Other Corp", issuePrefix: "OTH" })
      .returning({ id: companies.id });
    otherCompanyId = c2!.id;

    const [b] = await db
      .insert(contentBriefs)
      .values({
        companyId,
        title: "Onboarding for SaaS founders",
        thesis: "Good onboarding = better activation",
        audience: "SaaS founders 5k-100k MRR",
        angle: "how-to",
        keywords: ["onboarding", "activation"],
        status: "draft",
      })
      .returning({ id: contentBriefs.id });
    briefId = b!.id;
  });

  // ── B. Happy path ──────────────────────────────────────────────────────────

  it("B1: brief → 6 drafts created (one per format)", async () => {
    const result = await runContentGenerator(
      db,
      {
        companyId,
        briefId,
        actorType: "user",
        actorId: "user-test",
      },
      {
        apiKey: "sk-test",
        callAnthropic: stubCaller(makeValidLlmResponse()),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.drafts).toHaveLength(6);
    const formats = result.drafts.map((d) => d.format).sort();
    expect(formats).toEqual(["ad", "landing", "linkedin", "newsletter", "reel", "x-thread"]);
    expect(result.drafts.every((d) => d.generationError === null)).toBe(true);

    // Verify all 6 rows in DB.
    const rows = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.briefId, briefId));
    expect(rows).toHaveLength(6);
  });

  it("B2: re-generation overwrites drafts (latest-wins, not append)", async () => {
    const caller = stubCaller(makeValidLlmResponse());

    await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      { apiKey: "sk-test", callAnthropic: caller },
    );

    // Second run — should upsert, not append.
    const result2 = await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      { apiKey: "sk-test", callAnthropic: caller },
    );

    expect(result2.ok).toBe(true);

    // Still exactly 6 rows — no duplicates.
    const rows = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.briefId, briefId));
    expect(rows).toHaveLength(6);
  });

  it("B3: brief status transitions to 'review' after successful generation", async () => {
    await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      {
        apiKey: "sk-test",
        callAnthropic: stubCaller(makeValidLlmResponse()),
      },
    );

    const [brief] = await db
      .select({ status: contentBriefs.status })
      .from(contentBriefs)
      // and(eq, eq) — NEVER chain .where(a).where(b)
      .where(
        and(
          eq(contentBriefs.id, briefId),
          eq(contentBriefs.companyId, companyId),
        ),
      )
      .limit(1);

    expect(brief?.status).toBe("review");
  });

  it("B4: audit log row emits workflowId when provided", async () => {
    const workflowId = "00000000-0000-0000-0000-000000000001";

    await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      {
        apiKey: "sk-test",
        callAnthropic: stubCaller(makeValidLlmResponse()),
        workflowId,
      },
    );

    const rows = await db
      .select({ workflowId: activityLog.workflowId, action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityId, briefId),
        ),
      );

    const completedEntry = rows.find((r) => r.action === "content_generation.completed");
    expect(completedEntry).toBeDefined();
    expect(completedEntry?.workflowId).toBe(workflowId);
  });

  // ── C. Tenant isolation ────────────────────────────────────────────────────

  it("C1: brief belongs to other company → ok:false, no drafts written", async () => {
    // Create a brief under otherCompanyId.
    const [otherBrief] = await db
      .insert(contentBriefs)
      .values({
        companyId: otherCompanyId,
        title: "Other company brief",
        thesis: "Thesis",
        status: "draft",
      })
      .returning({ id: contentBriefs.id });

    // Attempt generation under companyId (wrong tenant).
    const result = await runContentGenerator(
      db,
      {
        companyId,
        briefId: otherBrief!.id,
        actorType: "user",
        actorId: "user-test",
      },
      {
        apiKey: "sk-test",
        callAnthropic: stubCaller(makeValidLlmResponse()),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not found/i);

    // Verify no drafts were written for the other company's brief.
    const rows = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.briefId, otherBrief!.id));
    expect(rows).toHaveLength(0);
  });

  it("C2: GET /content-drafts/:draftId with wrong company → 404", async () => {
    // Create a draft under companyId.
    await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      { apiKey: "sk-test", callAnthropic: stubCaller(makeValidLlmResponse()) },
    );

    const rows = await db
      .select({ id: contentDrafts.id })
      .from(contentDrafts)
      .where(eq(contentDrafts.briefId, briefId));
    expect(rows.length).toBeGreaterThan(0);

    const draftId = rows[0]!.id;

    // Build app acting as otherCompany.
    const app = buildApp(db, otherCompanyId);
    await request(app)
      .get(`/api/companies/${otherCompanyId}/content-drafts/${draftId}`)
      .expect(404);
  });

  // ── D. LLM failure path ────────────────────────────────────────────────────

  it("D1: LLM call throws → ok:false + error drafts written with generationError", async () => {
    const result = await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      {
        apiKey: "sk-test",
        callAnthropic: failingCaller("HTTP 529 overloaded"),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/529/);
    // Error drafts should have been written.
    expect(result.drafts.length).toBe(6);
    expect(result.drafts.every((d) => d.generationError !== null)).toBe(true);

    // Brief stays at 'drafting' (not 'review') on failure.
    const [brief] = await db
      .select({ status: contentBriefs.status })
      .from(contentBriefs)
      .where(
        and(
          eq(contentBriefs.id, briefId),
          eq(contentBriefs.companyId, companyId),
        ),
      )
      .limit(1);
    expect(brief?.status).toBe("drafting");
  });

  it("D2: LLM returns malformed JSON → ok:false + error drafts written", async () => {
    const result = await runContentGenerator(
      db,
      { companyId, briefId, actorType: "user", actorId: "user-test" },
      {
        apiKey: "sk-test",
        callAnthropic: malformedCaller(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/invalid/i);
    expect(result.drafts.length).toBe(6);
  });

  // ── E. Route-level tests ──────────────────────────────────────────────────

  it("E1: POST /generate returns 422 when no API key in env", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const app = buildApp(db, companyId);
      await request(app)
        .post(`/api/companies/${companyId}/content-briefs/${briefId}/generate`)
        .send({})
        .expect(422);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("E2: GET /content-drafts returns list scoped to company", async () => {
    // Seed 3 drafts for companyId by triggering generation (mocked).
    // Use a stub via env; the route reads process.env.ANTHROPIC_API_KEY, so
    // we test the full route stack in E3-E5. Here we insert directly.
    await db.insert(contentDrafts).values([
      {
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Test", hashtagSuggestions: [], estimatedReadTime: 1 },
        status: "drafted",
      },
      {
        companyId,
        briefId,
        format: "newsletter",
        payload: { subject: "Subj", body: "Body" },
        status: "drafted",
      },
    ]);

    const app = buildApp(db, companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/content-drafts`)
      .expect(200);

    expect(res.body.drafts).toHaveLength(2);
    expect(res.body.drafts.every((d: { companyId: string }) => d.companyId === companyId)).toBe(true);
  });

  it("E3: GET /content-drafts?briefId= filters correctly", async () => {
    // Create a second brief and draft under the same company.
    const [b2] = await db
      .insert(contentBriefs)
      .values({ companyId, title: "T2", thesis: "Thesis2", status: "draft" })
      .returning({ id: contentBriefs.id });

    await db.insert(contentDrafts).values([
      {
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Linked", hashtagSuggestions: [], estimatedReadTime: 1 },
        status: "drafted",
      },
      {
        companyId,
        briefId: b2!.id,
        format: "linkedin",
        payload: { body: "Other", hashtagSuggestions: [], estimatedReadTime: 1 },
        status: "drafted",
      },
    ]);

    const app = buildApp(db, companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/content-drafts?briefId=${briefId}`)
      .expect(200);

    expect(res.body.drafts).toHaveLength(1);
    expect(res.body.drafts[0].briefId).toBe(briefId);
  });

  it("E4: GET /content-drafts?format= filters correctly", async () => {
    await db.insert(contentDrafts).values([
      {
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "L", hashtagSuggestions: [], estimatedReadTime: 1 },
        status: "drafted",
      },
      {
        companyId,
        briefId,
        format: "newsletter",
        payload: { subject: "S", body: "B" },
        status: "drafted",
      },
    ]);

    const app = buildApp(db, companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/content-drafts?format=linkedin`)
      .expect(200);

    expect(res.body.drafts).toHaveLength(1);
    expect(res.body.drafts[0].format).toBe("linkedin");
  });

  it("E5: PATCH /content-drafts/:id sets publishedAt when status=published", async () => {
    const [draft] = await db
      .insert(contentDrafts)
      .values({
        companyId,
        briefId,
        format: "linkedin",
        payload: { body: "Post", hashtagSuggestions: [], estimatedReadTime: 1 },
        status: "drafted",
      })
      .returning({ id: contentDrafts.id });

    const app = buildApp(db, companyId);
    const res = await request(app)
      .patch(`/api/companies/${companyId}/content-drafts/${draft!.id}`)
      .send({ status: "published", publishedToUrl: "https://linkedin.com/post/123" })
      .expect(200);

    expect(res.body.status).toBe("published");
    expect(res.body.publishedAt).not.toBeNull();
    expect(res.body.publishedToUrl).toBe("https://linkedin.com/post/123");
  });

  // ── F. DB-level CHECK constraints ─────────────────────────────────────────

  it("F1: CHECK constraint rejects invalid format via raw SQL", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO "content_drafts" ("company_id", "brief_id", "format", "payload", "status")
            VALUES (${companyId}, ${briefId}, 'tiktok', '{}', 'drafted')`,
      ),
    ).rejects.toThrow();
  });

  it("F2: CHECK constraint rejects invalid status via raw SQL", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO "content_drafts" ("company_id", "brief_id", "format", "payload", "status")
            VALUES (${companyId}, ${briefId}, 'linkedin', '{}', 'viral')`,
      ),
    ).rejects.toThrow();
  });
});

// ── Test app builder ──────────────────────────────────────────────────────────

function buildApp(
  db: ReturnType<typeof createDb>,
  companyId: string,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", contentDraftRoutes(db));
  app.use(errorHandler);
  return app;
}
