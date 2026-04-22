/**
 * Wave 17E — conversation insight pipeline tests.
 *
 * Covers:
 *   1. Extraction API shape: the extractor parses a model response into the
 *      strict ExtractedInsight array.
 *   2. Promote-to-memory: POST /promote-insight writes a well-formed row into
 *      company_memory with the insight payload.
 *   3. Tenant isolation: a valid convId scoped to company-B cannot be fetched
 *      via a company-A URL — returns 404 rather than leaking data.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationExtractor,
  extractionResultSchema,
} from "../services/conversation-extractor.js";

// ---------------------------------------------------------------------------
// 1. Extractor — response shape
// ---------------------------------------------------------------------------

describe("conversationExtractor.extractInsights", () => {
  it("returns a well-formed ExtractedInsight[] when Anthropic returns valid JSON", async () => {
    const modelOutput = JSON.stringify({
      insights: [
        {
          title: "Tier-2 parents trust CBSE labels, not evidence language",
          content:
            "Parent A ignored clinical-validity framing and only trusted 'CBSE-aligned'. Lead with board-compliance language in Tier-2 city copy.",
          confidence: 0.82,
          source_quote: "Is this CBSE-approved?",
        },
        {
          title: "Principals block rollouts until BBPS is already integrated",
          content:
            "The principal refused to evaluate before BBPS settlement was live. Gate demos on BBPS-ready status.",
          confidence: 0.7,
          source_quote: "Come back once you are on BBPS.",
        },
      ],
    });

    const extractor = conversationExtractor({
      getAnthropicKey: async () => "sk-test",
      callAnthropic: async () => modelOutput,
    });

    const result = await extractor.extractInsights("Founder: ...\nParent A: Is this CBSE-approved?");

    // Re-validate against the Zod schema to make the shape contract explicit.
    const reparsed = extractionResultSchema.parse(result);
    expect(reparsed.insights).toHaveLength(2);
    expect(reparsed.insights[0]).toEqual({
      title: "Tier-2 parents trust CBSE labels, not evidence language",
      content:
        "Parent A ignored clinical-validity framing and only trusted 'CBSE-aligned'. Lead with board-compliance language in Tier-2 city copy.",
      confidence: 0.82,
      source_quote: "Is this CBSE-approved?",
    });
  });

  it("tolerates a fenced ```json block in the model output", async () => {
    const fenced = "```json\n" + JSON.stringify({
      insights: [
        {
          title: "Founders ignore AI-slop subject lines",
          content:
            "The prospect flagged 'AI-generated' phrasing in the opener as a reason to mute. Write openers that sound like a human wrote them.",
          confidence: 0.6,
          source_quote: "Your subject line screamed ChatGPT.",
        },
      ],
    }) + "\n```";

    const extractor = conversationExtractor({
      getAnthropicKey: async () => "sk-test",
      callAnthropic: async () => fenced,
    });

    const result = await extractor.extractInsights("transcript body goes here");
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].title).toContain("AI-slop");
  });

  it("throws when no Anthropic key is configured for the instance", async () => {
    const extractor = conversationExtractor({
      getAnthropicKey: async () => null,
      callAnthropic: async () => "unused",
    });

    await expect(
      extractor.extractInsights("transcript content"),
    ).rejects.toThrow(/Anthropic API key/i);
  });

  it("throws when the model output fails Zod validation", async () => {
    const badOutput = JSON.stringify({
      insights: [
        { title: "ok", content: "missing confidence + quote" },
      ],
    });

    const extractor = conversationExtractor({
      getAnthropicKey: async () => "sk-test",
      callAnthropic: async () => badOutput,
    });

    await expect(
      extractor.extractInsights("long enough transcript"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Route tests — promote-to-memory + tenant isolation
// ---------------------------------------------------------------------------

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockMemoryService = vi.hoisted(() => ({
  create: vi.fn(),
}));

// A tiny DB stub that mimics the drizzle fluent API for SELECT/INSERT/UPDATE.
// We only implement the methods the conversations route touches.
type AnyRow = Record<string, unknown>;
function makeDb(opts: {
  conversationRows?: AnyRow[];
  companyRows?: AnyRow[];
  insertedConversation?: AnyRow;
}) {
  const selectQueue: AnyRow[][] = [];
  // Every call to db.select().from(conversations)... returns conversationRows.
  // Every call to db.select().from(companies)... returns companyRows.
  // We don't have a safe way to discriminate targets in a stub, so queue in
  // route-call order: [conversationRows] or [companyRows].

  const selectImpl = vi.fn((projection?: unknown) => {
    // select() with no projection is a select * from a conversations row.
    // select({ name, description }) is the company context call — give it
    // companyRows. Discriminate by presence of projection.
    const fromImpl = vi.fn((_table: unknown) => {
      const rows = projection
        ? (opts.companyRows ?? [])
        : (opts.conversationRows ?? []);
      const whereChain: AnyRow = {
        then: (onfulfilled: (v: AnyRow[]) => unknown) =>
          Promise.resolve(rows).then(onfulfilled),
        catch: (onrejected: (e: unknown) => unknown) =>
          Promise.resolve(rows).catch(onrejected),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
        limit: vi.fn().mockResolvedValue(rows),
      };
      return { where: vi.fn().mockReturnValue(whereChain) };
    });
    return { from: fromImpl };
  });

  const insertImpl = vi.fn(() => ({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(
        opts.insertedConversation ? [opts.insertedConversation] : [],
      ),
    }),
  }));

  const updateImpl = vi.fn(() => ({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        catch: () => Promise.resolve([]),
        then: (onfulfilled: (v: unknown[]) => unknown) =>
          Promise.resolve([]).then(onfulfilled),
      }),
    }),
  }));

  return {
    db: {
      select: selectImpl,
      insert: insertImpl,
      update: updateImpl,
    } as unknown,
    selectQueue,
    insertImpl,
    updateImpl,
  };
}

function registerRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    logActivity: mockLogActivity,
    companyMemoryService: () => mockMemoryService,
  }));
  vi.doMock("../services/conversation-extractor.js", async () => {
    const actual = await vi.importActual<
      typeof import("../services/conversation-extractor.js")
    >("../services/conversation-extractor.js");
    return {
      ...actual,
      // Replace the DB-wired factory so routes don't need a real key.
      conversationExtractorFromDb: () => ({
        extractInsights: async () => ({ insights: [] }),
      }),
    };
  });
}

async function createRouteApp(db: unknown, actorCompanyIds: string[]) {
  const [{ errorHandler }, { conversationRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/conversations.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      companyIds: actorCompanyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", conversationRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("conversation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerRouteMocks();
    vi.clearAllMocks();
  });

  it("promote-insight writes the extracted insight into company_memory as a founder_note", async () => {
    const conversationRow = {
      id: "conv-1",
      companyId: "company-1",
      title: "Call with Kamal",
      participants: ["Founder", "Kamal"],
      sourceKind: "transcript_paste",
      transcript: "Founder: ...\nKamal: Is this CBSE-approved?",
      extractionStatus: "complete",
      extractedInsights: [
        {
          title: "Tier-2 parents trust CBSE labels",
          content:
            "Parent A ignored clinical language and only trusted 'CBSE-aligned'.",
          confidence: 0.8,
          source_quote: "Is this CBSE-approved?",
        },
      ],
      createdAt: new Date("2026-04-20T10:00:00Z"),
      completedAt: new Date("2026-04-20T10:00:30Z"),
    };

    const { db } = makeDb({ conversationRows: [conversationRow] });
    const app = await createRouteApp(db, ["company-1"]);

    mockMemoryService.create.mockResolvedValue({
      id: "mem-1",
      companyId: "company-1",
      kind: "founder_note",
      title: "Tier-2 parents trust CBSE labels",
      body: "…",
      topic: null,
      pinned: false,
      source: "manual",
      occurredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/companies/company-1/conversations/conv-1/promote-insight")
      .send({ index: 0 });

    expect(res.status).toBe(201);
    expect(mockMemoryService.create).toHaveBeenCalledTimes(1);
    const [companyIdArg, payload] = mockMemoryService.create.mock.calls[0];
    expect(companyIdArg).toBe("company-1");
    expect(payload).toMatchObject({
      kind: "founder_note",
      title: "Tier-2 parents trust CBSE labels",
      source: "manual",
      pinned: false,
    });
    // Body must include both the content and the verbatim source quote so the
    // founder can trace the insight back to the conversation.
    expect(payload.body).toContain("clinical language");
    expect(payload.body).toContain("Is this CBSE-approved?");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "conversation.insight_promoted",
        entityType: "company_memory",
        entityId: "mem-1",
      }),
    );
  });

  it("returns 404 when a conversation belongs to a different company (tenant isolation)", async () => {
    // The DB stub returns [] because the route's where() clause ANDs on
    // companyId — this simulates the real behaviour.
    const { db } = makeDb({ conversationRows: [] });
    const app = await createRouteApp(db, ["company-A"]);

    const res = await request(app).get(
      "/api/companies/company-A/conversations/conv-belonging-to-B",
    );

    expect(res.status).toBe(404);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("denies access when the board actor is not a member of the company", async () => {
    const { db } = makeDb({ conversationRows: [] });
    // Actor is member of company-X, but the URL says company-Y.
    const app = await createRouteApp(db, ["company-X"]);

    const res = await request(app).get(
      "/api/companies/company-Y/conversations",
    );

    expect(res.status).toBe(403);
  });
});
