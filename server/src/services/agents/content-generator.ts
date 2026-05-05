/**
 * content-generator.ts — Multi-format content generator (S4.2).
 *
 * Takes a content_brief and fans out into 6 channel-specific drafts:
 *   linkedin, x-thread, newsletter, reel, landing, ad
 *
 * Pipeline:
 *   1. Load the brief from DB (verify it belongs to companyId).
 *   2. Build the user prompt — brief fields only; no PII from details JSON.
 *   3. Single Anthropic call (non-streaming — background job, not user-facing SSE).
 *      max_tokens = 4096; model = claude-sonnet-4-6.
 *   4. Zod-validate the 6-key envelope.
 *   5. Upsert into content_drafts (brief_id, format) — latest-wins.
 *   6. Transition brief to 'review' on success; leave at 'drafting' on failure.
 *   7. Emit an activity log entry (with optional workflowId for audit).
 *
 * Failure contract:
 *   - LLM error or schema failure → each draft row is written with
 *     status='drafted', payload='{}', generationError=<reason>.
 *     Brief stays at 'drafting' so the founder can see it failed.
 *   - Never throws — all errors are captured into the result object.
 *
 * No PII in prompts:
 *   Only brief.title, brief.thesis, brief.audience, brief.angle, brief.keywords,
 *   and brief.notesMarkdown are passed to the LLM. No company user names,
 *   email addresses, or details JSON fields are included.
 *
 * Streaming:
 *   NOT used here — this is a background generation triggered by a POST.
 *   Per vinamr-invariants: streaming is for user-facing SSE; background jobs
 *   use the standard messages endpoint to avoid connection hold-time multiplication.
 *
 * Rate limits:
 *   Anthropic returns 529 (overloaded) in addition to 429. Both are retried
 *   by the caller if needed; this service does not retry internally.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import {
  contentBriefs,
  contentDrafts,
  CONTENT_DRAFT_FORMATS,
  type ContentDraftFormat,
  type ContentDraftPayload,
} from "@founderos/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";

// ── Anthropic configuration ──────────────────────────────────────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
/** claude-sonnet-4-6: best coding + structured output; same model as growth-suggester. */
const GENERATION_MODEL = "claude-sonnet-4-6";
const GENERATION_TIMEOUT_MS = 90_000;
/**
 * 4096 tokens accommodates all 6 formats comfortably (typical output ~2k tokens).
 * max_tokens is REQUIRED — Anthropic SDK throws at runtime if omitted.
 */
const MAX_TOKENS = 4096;

// ── Public types ─────────────────────────────────────────────────────────────

export type AnthropicCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

export type ContentGeneratorOptions = {
  /** Anthropic API key (required). */
  apiKey: string;
  /**
   * Optional workflow id — passed to logActivity so the audit trail can be
   * filtered by workflow. Set this when generation was triggered from a
   * workflow lifecycle (S4.5 integration point).
   */
  workflowId?: string | null;
  /** DI hook for the LLM caller (test seam). */
  callAnthropic?: AnthropicCaller;
  /** Override system prompt path (test seam). */
  systemPromptOverride?: string;
};

export type ContentGeneratorSuccess = {
  ok: true;
  briefId: string;
  runId: string;
  drafts: Array<{
    id: string;
    format: ContentDraftFormat;
    status: "drafted";
    generationError: null;
  }>;
};

export type ContentGeneratorError = {
  ok: false;
  briefId: string;
  runId: string;
  reason: string;
  /** Drafts written with error payload — may be empty if DB write itself failed. */
  drafts: Array<{
    id: string;
    format: ContentDraftFormat;
    status: "drafted";
    generationError: string;
  }>;
};

// ── Zod schema for the LLM output envelope ───────────────────────────────────

const linkedInPostSchema = z.object({
  body: z.string().min(1).max(5000),
  hashtagSuggestions: z.array(z.string()).min(0).max(10),
  estimatedReadTime: z.number().int().min(1).max(30),
});

const xThreadSchema = z.object({
  tweets: z.array(z.string().max(280)).min(1).max(20),
  commentary: z.string().min(1).max(1000),
});

const newsletterSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(50000),
});

const reelScriptSchema = z.object({
  hook: z.string().min(1).max(500),
  valueBeats: z.array(z.string()).min(1).max(10),
  cta: z.string().min(1).max(200),
  runtime: z.string().min(1).max(20),
});

const landingCopySchema = z.object({
  headline: z.string().min(1).max(200),
  subheadline: z.string().min(1).max(500),
  bullets: z.array(z.string()).min(1).max(10),
  cta: z.string().min(1).max(100),
});

const adCreativeSchema = z.object({
  primaryText: z.string().min(1).max(500),
  headline: z.string().min(1).max(100),
  description: z.string().min(1).max(100),
});

export const generatedContentSchema = z.object({
  linkedinPost: linkedInPostSchema,
  xThread: xThreadSchema,
  newsletter: newsletterSchema,
  reelScript: reelScriptSchema,
  landingCopy: landingCopySchema,
  adCreative: adCreativeSchema,
});

export type GeneratedContent = z.infer<typeof generatedContentSchema>;

// ── Prompt loading ───────────────────────────────────────────────────────────

let cachedSystemPrompt: string | null = null;

export async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const promptPath = fileURLToPath(
    new URL("./__prompts__/content-generator.md", import.meta.url),
  );
  const content = await readFile(promptPath, "utf8");
  cachedSystemPrompt = content;
  return content;
}

// ── User prompt builder (NO PII) ─────────────────────────────────────────────

type BriefInput = {
  title: string;
  thesis: string;
  audience: string | null;
  angle: string | null;
  keywords: string[] | null;
  notesMarkdown: string | null;
};

export function buildUserPrompt(brief: BriefInput): string {
  const lines: string[] = [];

  lines.push(`## Content brief`);
  lines.push(`Title: ${brief.title}`);
  lines.push(`Thesis (one-line hook): ${brief.thesis}`);

  if (brief.audience) {
    lines.push(`Target audience: ${brief.audience}`);
  }
  if (brief.angle) {
    lines.push(`Angle: ${brief.angle}`);
  }
  if (brief.keywords && brief.keywords.length > 0) {
    lines.push(`Keywords to weave in: ${brief.keywords.join(", ")}`);
  }
  if (brief.notesMarkdown && brief.notesMarkdown.trim()) {
    // Truncate to 2000 chars to bound prompt size; founder notes can be long.
    const notes = brief.notesMarkdown.slice(0, 2000);
    lines.push(`\nFounder notes:\n${notes}`);
  }

  lines.push(
    "\nGenerate all six formats now. Return ONLY the JSON object — no fences, no commentary.",
  );

  return lines.join("\n");
}

// ── JSON extractor (mirrors growth-suggester.ts pattern) ────────────────────

export function extractJsonObject(raw: string): unknown {
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch?.[1]) s = fenceMatch[1].trim();

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("No JSON object found in LLM response");
  }
  return JSON.parse(s.slice(first, last + 1));
}

// ── Default Anthropic caller ─────────────────────────────────────────────────

async function defaultCallAnthropic(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: GENERATION_MODEL,
        // max_tokens is REQUIRED — Anthropic SDK throws at runtime if omitted.
        max_tokens: MAX_TOKENS,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      // 529 = overloaded (Anthropic-specific), 429 = rate limit — surface both.
      throw new Error(
        `Anthropic request failed (HTTP ${response.status}): ${bodyText.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = (payload.content ?? [])
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text ?? "")
      .join("");

    if (!text.trim()) {
      throw new Error("Anthropic returned empty content");
    }
    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Format → payload key map ─────────────────────────────────────────────────

type FormatKey = keyof GeneratedContent;

const FORMAT_TO_KEY: Record<ContentDraftFormat, FormatKey> = {
  linkedin: "linkedinPost",
  "x-thread": "xThread",
  newsletter: "newsletter",
  reel: "reelScript",
  landing: "landingCopy",
  ad: "adCreative",
};

// ── Upsert helpers ───────────────────────────────────────────────────────────

/**
 * Upsert a single draft row (brief_id, format) — latest-wins on conflict.
 * Returns the resulting row id.
 */
async function upsertDraft(
  db: Db,
  params: {
    companyId: string;
    briefId: string;
    format: ContentDraftFormat;
    payload: ContentDraftPayload;
    runId: string;
    generationError: string | null;
  },
): Promise<string> {
  const now = new Date();
  const [row] = await db
    .insert(contentDrafts)
    .values({
      companyId: params.companyId,
      briefId: params.briefId,
      format: params.format,
      payload: params.payload,
      status: "drafted",
      generatedByRunId: params.runId,
      generationError: params.generationError,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // Conflict target: the UNIQUE(brief_id, format) index.
      target: [contentDrafts.briefId, contentDrafts.format],
      set: {
        payload: params.payload,
        status: "drafted",
        generatedByRunId: params.runId,
        generationError: params.generationError,
        publishedAt: null,
        publishedToUrl: null,
        updatedAt: now,
      },
    })
    .returning({ id: contentDrafts.id });

  return row!.id;
}

// ── Brief status helpers ─────────────────────────────────────────────────────

async function transitionBriefStatus(
  db: Db,
  briefId: string,
  companyId: string,
  status: "drafting" | "review",
): Promise<void> {
  // NEVER chain .where(a).where(b) — use and(eq, eq) per vinamr-invariants.
  await db
    .update(contentBriefs)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(contentBriefs.id, briefId), eq(contentBriefs.companyId, companyId)),
    );
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Run the multi-format content generator for the given brief.
 *
 * Returns a structured result — never throws. Errors are captured into the
 * result so callers can surface them to the founder without crashing the route.
 */
export async function runContentGenerator(
  db: Db,
  params: {
    companyId: string;
    briefId: string;
    actorType: "agent" | "user" | "system";
    actorId: string;
    agentId?: string | null;
  },
  options: ContentGeneratorOptions,
): Promise<ContentGeneratorSuccess | ContentGeneratorError> {
  const log = logger.child({
    service: "content-generator",
    companyId: params.companyId,
    briefId: params.briefId,
  });

  const callAnthropic = options.callAnthropic ?? defaultCallAnthropic;
  const runId = randomUUID();

  // ── 1. Load the brief ──────────────────────────────────────────────────────
  // NEVER chain .where(a).where(b) — and(eq, eq) per vinamr-invariants.
  const [brief] = await db
    .select()
    .from(contentBriefs)
    .where(
      and(
        eq(contentBriefs.id, params.briefId),
        eq(contentBriefs.companyId, params.companyId),
      ),
    )
    .limit(1);

  if (!brief) {
    return {
      ok: false,
      briefId: params.briefId,
      runId,
      reason: `Brief not found: ${params.briefId} in company ${params.companyId}`,
      drafts: [],
    };
  }

  // ── 2. Transition brief → 'drafting' ──────────────────────────────────────
  // Only transition from states that allow it; skip if already drafting.
  if (brief.status !== "drafting") {
    await transitionBriefStatus(db, params.briefId, params.companyId, "drafting");
  }

  // ── 3. Build prompts (NO PII — only brief intent fields) ──────────────────
  const systemPrompt =
    options.systemPromptOverride ?? (await loadSystemPrompt());
  const userPrompt = buildUserPrompt({
    title: brief.title,
    thesis: brief.thesis,
    audience: brief.audience,
    angle: brief.angle,
    keywords: brief.keywords,
    // notesMarkdown may contain anything the founder typed — pass as-is but
    // the buildUserPrompt function caps it at 2000 chars to bound prompt size.
    // No emails, names, or structured PII is extracted from it.
    notesMarkdown: brief.notesMarkdown,
  });

  // ── 4. LLM call ───────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await callAnthropic({
      apiKey: options.apiKey,
      systemPrompt,
      userPrompt,
    });
  } catch (err) {
    const reason = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ reason }, "content-generator: LLM call failed");

    // Write error drafts for all 6 formats so the UI can surface per-format errors.
    const drafts = await writeErrorDrafts(
      db,
      params.companyId,
      params.briefId,
      runId,
      reason,
    );

    await logActivity(db, {
      companyId: params.companyId,
      actorType: params.actorType,
      actorId: params.actorId,
      action: "content_generation.failed",
      entityType: "content_brief",
      entityId: params.briefId,
      agentId: params.agentId ?? null,
      workflowId: options.workflowId ?? null,
      details: { runId, reason: reason.slice(0, 500), briefId: params.briefId },
    });

    return { ok: false, briefId: params.briefId, runId, reason, drafts };
  }

  // ── 5. Parse + validate ───────────────────────────────────────────────────
  let generated: GeneratedContent;
  try {
    const parsed = extractJsonObject(raw);
    const result = generatedContentSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Schema validation failed: ${result.error.message}`);
    }
    generated = result.data;
  } catch (err) {
    const reason = `LLM output invalid: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ reason, rawSnippet: raw.slice(0, 200) }, "content-generator: parse/validate failed");

    const drafts = await writeErrorDrafts(
      db,
      params.companyId,
      params.briefId,
      runId,
      reason,
    );

    await logActivity(db, {
      companyId: params.companyId,
      actorType: params.actorType,
      actorId: params.actorId,
      action: "content_generation.failed",
      entityType: "content_brief",
      entityId: params.briefId,
      agentId: params.agentId ?? null,
      workflowId: options.workflowId ?? null,
      details: { runId, reason: reason.slice(0, 500), briefId: params.briefId },
    });

    return { ok: false, briefId: params.briefId, runId, reason, drafts };
  }

  // ── 6. Upsert drafts ──────────────────────────────────────────────────────
  const draftResults: ContentGeneratorSuccess["drafts"] = [];

  for (const format of CONTENT_DRAFT_FORMATS) {
    const key = FORMAT_TO_KEY[format];
    const payload = generated[key] as ContentDraftPayload;

    const id = await upsertDraft(db, {
      companyId: params.companyId,
      briefId: params.briefId,
      format,
      payload,
      runId,
      generationError: null,
    });

    draftResults.push({ id, format, status: "drafted", generationError: null });
  }

  // ── 7. Transition brief → 'review' ────────────────────────────────────────
  await transitionBriefStatus(db, params.briefId, params.companyId, "review");

  // ── 8. Audit log ──────────────────────────────────────────────────────────
  await logActivity(db, {
    companyId: params.companyId,
    actorType: params.actorType,
    actorId: params.actorId,
    action: "content_generation.completed",
    entityType: "content_brief",
    entityId: params.briefId,
    agentId: params.agentId ?? null,
    workflowId: options.workflowId ?? null,
    details: {
      runId,
      briefId: params.briefId,
      formatsGenerated: CONTENT_DRAFT_FORMATS.length,
      draftIds: draftResults.map((d) => d.id),
    },
  });

  log.info(
    { runId, formats: CONTENT_DRAFT_FORMATS.length },
    "content-generator: generation complete",
  );

  return {
    ok: true,
    briefId: params.briefId,
    runId,
    drafts: draftResults,
  };
}

// ── Error draft writer ────────────────────────────────────────────────────────

async function writeErrorDrafts(
  db: Db,
  companyId: string,
  briefId: string,
  runId: string,
  reason: string,
): Promise<ContentGeneratorError["drafts"]> {
  const results: ContentGeneratorError["drafts"] = [];
  for (const format of CONTENT_DRAFT_FORMATS) {
    try {
      const id = await upsertDraft(db, {
        companyId,
        briefId,
        format,
        payload: {} as ContentDraftPayload,
        runId,
        generationError: reason.slice(0, 1000),
      });
      results.push({ id, format, status: "drafted", generationError: reason });
    } catch (dbErr) {
      // Non-fatal — log and continue. The caller's ok:false result still surfaces.
      logger.warn(
        {
          err: dbErr instanceof Error ? dbErr.message : String(dbErr),
          format,
          briefId,
        },
        "content-generator: error draft write failed (non-fatal)",
      );
    }
  }
  return results;
}
