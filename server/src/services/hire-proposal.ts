import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { agents as agentsTable, companies as companiesTable } from "@founderos/db";
import type { Agent, AgentRole } from "@founderos/shared";
import { logger } from "../middleware/logger.js";

export type DepartmentId =
  | "chief-of-staff"
  | "growth"
  | "content"
  | "crm"
  | "finance"
  | "engineering"
  | "ops";

export const hireProposalSchema = z.object({
  name: z.string().min(1),
  role: z.enum([
    "ceo",
    "cto",
    "cmo",
    "cfo",
    "engineer",
    "designer",
    "pm",
    "qa",
    "devops",
    "researcher",
    "general",
  ]),
  title: z.string().min(1),
  reportsTo: z.string().nullable(),
  briefMarkdown: z.string().min(1),
  monthlyCompCents: z.number().int().positive(),
  department: z.enum([
    "chief-of-staff",
    "growth",
    "content",
    "crm",
    "finance",
    "engineering",
    "ops",
  ]),
  rationale: z.string().min(1),
});

export type HireProposal = z.infer<typeof hireProposalSchema>;

// ─── Fallback keyword matching ─────────────────────────────────────────────

interface FallbackBucket {
  keywords: string[];
  name: string;
  role: AgentRole;
  title: string;
  department: DepartmentId;
  monthlyCompCents: number;
}

const FALLBACK_BUCKETS: FallbackBucket[] = [
  {
    keywords: ["growth", "marketing", "outbound", "linkedin", "acquisition", "gtm", "demand"],
    name: "Orbit",
    role: "cmo",
    title: "Head of Growth",
    department: "growth",
    monthlyCompCents: 20_000,
  },
  {
    keywords: ["engineer", "coder", "pull request", "ship features", "build features", "deploy", "frontend", "backend", "fullstack", "developer", "software"],
    name: "Forge",
    role: "engineer",
    title: "Senior Engineer",
    department: "engineering",
    monthlyCompCents: 25_000,
  },
  {
    keywords: ["cfo", "finance", "runway", "burn", "budget", "accounting", "money", "revenue", "pricing"],
    name: "Ledger",
    role: "cfo",
    title: "CFO",
    department: "finance",
    monthlyCompCents: 15_000,
  },
  {
    keywords: ["design", "ux", "ui", "figma", "brand", "visual", "creative"],
    name: "Canvas",
    role: "designer",
    title: "Product Designer",
    department: "content",
    monthlyCompCents: 20_000,
  },
  {
    keywords: ["product", "pm", "roadmap", "feature", "spec", "backlog", "priorit"],
    name: "Vector",
    role: "pm",
    title: "Product Manager",
    department: "ops",
    monthlyCompCents: 20_000,
  },
  {
    keywords: ["research", "analyst", "data", "insight", "competitive", "market"],
    name: "Prism",
    role: "researcher",
    title: "Research Analyst",
    department: "content",
    monthlyCompCents: 18_000,
  },
  {
    keywords: ["devops", "infra", "infrastructure", "ci", "cd", "kubernetes", "aws", "gcp", "azure", "docker"],
    name: "Atlas",
    role: "devops",
    title: "DevOps Engineer",
    department: "engineering",
    monthlyCompCents: 22_000,
  },
  {
    keywords: ["qa", "quality assurance", "testing", "bug", "quality engineer"],
    name: "Sentinel",
    role: "qa",
    title: "QA Engineer",
    department: "engineering",
    monthlyCompCents: 18_000,
  },
  {
    keywords: ["content", "write", "writer", "copy", "blog", "seo", "social"],
    name: "Draft",
    role: "researcher",
    title: "Content Strategist",
    department: "content",
    monthlyCompCents: 18_000,
  },
  {
    keywords: ["cto", "tech", "technical", "architecture", "platform"],
    name: "Apex",
    role: "cto",
    title: "CTO",
    department: "engineering",
    monthlyCompCents: 25_000,
  },
  {
    keywords: ["sales", "revenue", "deals", "pipeline", "crm", "account"],
    name: "Meridian",
    role: "general",
    title: "Head of Sales",
    department: "crm",
    monthlyCompCents: 20_000,
  },
];

const DEFAULT_BUCKET: Omit<FallbackBucket, "keywords"> = {
  name: "Nova",
  role: "general",
  title: "Chief of Staff",
  department: "ops",
  monthlyCompCents: 15_000,
};

function fallbackProposal(intent: string, reportsToName: string | null): HireProposal {
  const lower = intent.toLowerCase();
  const bucket = FALLBACK_BUCKETS.find((b) => b.keywords.some((kw) => lower.includes(kw))) ?? DEFAULT_BUCKET;

  const briefMarkdown = `## What they own
${bucket.title} is responsible for driving results in their core domain. They own the strategy, execution, and day-to-day decisions within their scope.

## How they succeed
Success is measured by clear, trackable outcomes: hitting key metrics, shipping on time, and keeping the founder unblocked. They proactively surface blockers and opportunities without waiting to be asked.

## First 30 days
The first month is about speed and context. Understand the current state, identify the top 3 levers, ship one quick win, and build a 90-day plan for approval.

## What "done" looks like
This role is complete when the function runs autonomously — the founder no longer needs to think about this domain daily.

---
_Role drafted in response to: "${intent}"_`;

  return {
    name: bucket.name,
    role: bucket.role,
    title: bucket.title,
    reportsTo: reportsToName,
    briefMarkdown,
    monthlyCompCents: bucket.monthlyCompCents,
    department: bucket.department,
    rationale: `(Fallback: CEO teammate couldn't respond — using template.) Role matched from intent: "${intent.slice(0, 100)}"`,
  };
}

// ─── LLM drafting ─────────────────────────────────────────────────────────

function buildDraftPrompt(params: {
  companyName: string;
  charter: string | null;
  intent: string;
  teammates: { name: string; title: string | null; role: AgentRole }[];
  previousDraft?: HireProposal;
}): string {
  const teamList =
    params.teammates.length > 0
      ? params.teammates.map((t) => `- ${t.name} · ${t.title ?? t.role} · ${t.role}`).join("\n")
      : "(no teammates yet)";

  const redraftNote = params.previousDraft
    ? `\n\nThe founder reviewed a previous draft and didn't like it. Try a different angle. Previous name was "${params.previousDraft.name}", role was "${params.previousDraft.role}".\n`
    : "";

  return `You are the CEO of ${params.companyName}. Your founder just said: "${params.intent}"${redraftNote}

Draft a complete hiring proposal. Return ONLY a JSON object with these exact fields:
  name (one word, unique-sounding like a starship or constellation name — must differ from existing teammates)
  role (one of: ceo | cto | cmo | cfo | engineer | designer | pm | qa | devops | researcher | general)
  title (human job title)
  reportsTo (name of an existing teammate from the list below, or null)
  briefMarkdown (4-6 paragraphs in markdown: what they own, how they succeed, first-30-days plan, what "done" looks like for this role)
  monthlyCompCents (integer; reasonable range 15000-50000 cents i.e. $150-$500/month)
  department (one of: chief-of-staff | growth | content | crm | finance | engineering | ops)
  rationale (1-2 lines explaining why this role is needed now)

Current team:
${teamList}

Company charter: ${params.charter ?? "(not set)"}

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation text
- name must be a single word
- reportsTo must be null or exactly match a teammate name from the list above`;
}

function extractJson(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Extract balanced braces
    const start = text.indexOf("{");
    if (start === -1) throw new Error("No JSON object found in response");
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          return JSON.parse(text.slice(start, i + 1));
        }
      }
    }
    throw new Error("Unbalanced JSON in response");
  }
}

// ─── Public service ────────────────────────────────────────────────────────

export interface DraftHireProposalParams {
  db: Db;
  companyId: string;
  intent: string;
  previousDraft?: HireProposal;
}

export async function draftHireProposal(params: DraftHireProposalParams): Promise<HireProposal> {
  const { db, companyId, intent, previousDraft } = params;

  // Load company
  const companyRows = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .then((rows) => rows);
  const company = companyRows[0] ?? null;
  if (!company) {
    throw new Error(`Company ${companyId} not found`);
  }

  // Load all teammates
  const allAgents = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.companyId, companyId)))
    .then((rows) => rows);

  const activeAgents = allAgents.filter((a) => a.status !== "terminated");

  // Find CEO
  const ceoAgent = activeAgents.find((a) => a.role === "ceo");
  if (!ceoAgent) {
    throw new Error(
      "A CEO teammate must exist before drafting hires. Complete onboarding first.",
    );
  }

  const teammates = activeAgents.map((a) => ({
    name: a.name,
    title: a.title ?? null,
    role: (a.role ?? "general") as AgentRole,
  }));

  const charter = (company.metrics as { charter?: string } | null)?.charter ?? null;
  const companyName = company.name;

  // Determine reports-to default (report to CEO by name)
  const defaultReportsTo = ceoAgent.name;

  // Try LLM via the CEO's adapter
  try {
    const { findActiveServerAdapter } = await import("../adapters/index.js");
    const adapterType = ceoAgent.adapterType ?? "process";
    const adapter = findActiveServerAdapter(adapterType);
    const adapterAsAny = adapter as unknown as Record<string, unknown> | null;

    if (adapterAsAny && typeof adapterAsAny["chatCompletion"] === "function") {
      const prompt = buildDraftPrompt({ companyName, charter, intent, teammates, previousDraft });
      const chatCompletion = adapterAsAny["chatCompletion"] as (p: string, cfg: Record<string, unknown>) => Promise<string>;
      const completion = await chatCompletion(
        prompt,
        { adapterConfig: ceoAgent.adapterConfig ?? {} },
      );
      const raw = extractJson(completion);
      const parsed = hireProposalSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
      logger.warn({ parseError: parsed.error.message }, "hire-proposal: LLM returned invalid schema, falling back");
    }
  } catch (err) {
    logger.warn({ err }, "hire-proposal: LLM path failed, falling back to keyword matching");
  }

  // Fallback
  return fallbackProposal(intent, defaultReportsTo);
}
