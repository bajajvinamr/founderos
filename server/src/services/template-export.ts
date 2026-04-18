/**
 * Template export service.
 *
 * Takes an existing company and serializes its agents, goals, projects,
 * and issues as a `CompanyTemplate` JSON. The output plugs directly back
 * into `templateSpawnService.spawn()` — meaning "fork my Acme Co as a
 * new company" is a complete, stable round-trip.
 *
 * Heartbeat runs, cost events, and activity log are NOT included; those
 * are per-instance state that shouldn't follow a template. API keys are
 * also stripped — templates are shareable blueprints, not credential bundles.
 */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  companies,
  agents,
  goals,
  projects,
  issues,
} from "@founderos/db";
import type { CompanyTemplate } from "@founderos/shared";
import { notFound } from "../errors.js";

export function templateExportService(db: Db) {
  async function exportCompany(companyId: string): Promise<CompanyTemplate> {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) throw notFound(`Company not found: ${companyId}`);

    const [agentRows, goalRows, projectRows] = await Promise.all([
      db.select().from(agents).where(eq(agents.companyId, companyId)),
      db.select().from(goals).where(eq(goals.companyId, companyId)),
      db.select().from(projects).where(eq(projects.companyId, companyId)),
    ]);

    // Issues can be large; bound to open + recently-closed so the template
    // doesn't balloon. Templates are starter kits, not archives.
    const issueRows = agentRows.length === 0
      ? []
      : await db
          .select()
          .from(issues)
          .where(
            inArray(
              issues.assigneeAgentId,
              agentRows.map((a) => a.id),
            ),
          )
          .limit(200);

    // Build stable keys (slugified) for cross-references.
    const agentKeyById = new Map<string, string>();
    const agentSlug = makeSlugger();
    for (const a of agentRows) {
      agentKeyById.set(a.id, agentSlug(a.role + "-" + a.name));
    }
    const goalKeyById = new Map<string, string>();
    const goalSlug = makeSlugger();
    for (const g of goalRows) {
      goalKeyById.set(g.id, goalSlug("g-" + g.title));
    }
    const projectKeyById = new Map<string, string>();
    const projectSlug = makeSlugger();
    for (const p of projectRows) {
      projectKeyById.set(p.id, projectSlug("p-" + p.name));
    }

    const template: CompanyTemplate = {
      id: slugify(`${company.name}-export-${Date.now()}`),
      name: `${company.name} — Forked`,
      tagline: `Forked from ${company.name}`,
      summary:
        (company.description ?? `A fork of the ${company.name} company.`).slice(0, 800),
      icon: "📂",
      issuePrefix: deriveIssuePrefix(company.name),
      budgetUsd: Math.max(50, Math.round((company.budgetMonthlyCents ?? 0) / 100)),
      category: "custom",
      metrics: (company.metrics as CompanyTemplate["metrics"]) ?? {},
      agents: agentRows.map((a) => ({
        key: agentKeyById.get(a.id)!,
        name: a.name,
        role: a.role,
        title: a.title ?? a.role,
        icon: a.icon ?? "🤖",
        reportsTo: a.reportsTo ? agentKeyById.get(a.reportsTo) : undefined,
        budgetUsd: Math.max(10, Math.round((a.budgetMonthlyCents ?? 0) / 100)),
        capabilities: a.capabilities ?? "",
        heartbeatPrompt: readPromptTemplate(a.adapterConfig) ?? "Each heartbeat: review open issues assigned to you and advance the highest-priority one.",
        provider: preferenceFromAgent(a),
        maxTurnsPerRun: readMaxTurns(a.adapterConfig),
      })),
      goals: goalRows
        .filter((g) => g.ownerAgentId && agentKeyById.has(g.ownerAgentId))
        .map((g) => ({
          key: goalKeyById.get(g.id)!,
          title: g.title,
          description: g.description ?? "",
          ownerKey: agentKeyById.get(g.ownerAgentId!)!,
        })),
      projects: projectRows
        .filter((p) => p.goalId && goalKeyById.has(p.goalId) && p.leadAgentId && agentKeyById.has(p.leadAgentId))
        .map((p) => ({
          key: projectKeyById.get(p.id)!,
          name: p.name,
          description: p.description ?? "",
          goalKey: goalKeyById.get(p.goalId!)!,
          leadKey: agentKeyById.get(p.leadAgentId!)!,
        })),
      issues: issueRows
        .filter(
          (i) =>
            i.projectId &&
            projectKeyById.has(i.projectId) &&
            (i.status === "backlog" || i.status === "todo" || i.status === "in_progress"),
        )
        .map((i) => ({
          projectKey: projectKeyById.get(i.projectId!)!,
          title: i.title,
          description: i.description ?? "",
          status: (i.status as "backlog" | "todo" | "in_progress") ?? "backlog",
          priority: (i.priority as "low" | "medium" | "high" | "urgent") ?? "medium",
          assigneeKey:
            i.assigneeAgentId && agentKeyById.has(i.assigneeAgentId)
              ? agentKeyById.get(i.assigneeAgentId)
              : undefined,
        })),
    };

    return template;
  }

  return { exportCompany };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 100);
}

function makeSlugger() {
  const seen = new Map<string, number>();
  return (value: string): string => {
    const base = slugify(value) || "item";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

function deriveIssuePrefix(name: string): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
  return letters.padEnd(3, "X");
}

function readPromptTemplate(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as Record<string, unknown>).promptTemplate;
  return typeof raw === "string" ? raw : undefined;
}

function readMaxTurns(config: unknown): number | undefined {
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as Record<string, unknown>).maxTurnsPerRun;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function preferenceFromAgent(
  agent: { adapterType: string; adapterConfig: unknown },
): CompanyTemplate["agents"][number]["provider"] {
  const model = readModel(agent.adapterConfig);
  const adapter = agent.adapterType;
  const family =
    adapter === "claude_local" || adapter === "claude_api"
      ? "anthropic"
      : adapter === "codex_local" || adapter === "openai_api"
        ? "openai"
        : adapter === "gemini_local"
          ? "google"
          : "other";
  if (family === "other") {
    return undefined;
  }
  const execution: "cli" | "api" = adapter.endsWith("_api") ? "api" : "cli";
  return {
    families: [family],
    suggestedModels: model ? { [family]: model } as Record<string, string> : {},
    preferredExecution: execution === "cli" ? "cli" : "api",
  };
}

function readModel(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as Record<string, unknown>).model;
  return typeof raw === "string" ? raw : undefined;
}
