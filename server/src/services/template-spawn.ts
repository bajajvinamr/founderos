/**
 * Company-from-template spawn service.
 *
 * Takes a template id + overrides → creates a fully wired company
 * (agents with reports-to, goals, projects, starter issues) in a single
 * transaction. This powers the onboarding "Pick a template" flow — the
 * 10-minutes-from-signup-to-live-company promise.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  companies,
  agents,
  goals,
  projects,
  issues,
  companyMemberships,
} from "@founderos/db";
import type {
  CompanyTemplate,
  TemplateAgentSeed,
} from "@founderos/shared";
import { getTemplate } from "@founderos/templates";
import { notFound, unprocessable } from "../errors.js";
import {
  resolveAgentAdaptersBatch,
  type ProviderStrategy,
  type ResolvedAdapter,
} from "./adapter-resolver.js";
import { getProviderAvailability } from "./provider-credentials.js";
import { instanceApiKeysService } from "./instance-api-keys.js";

export type SpawnFromTemplateInput = {
  /**
   * Either reference a built-in template by id, OR pass an inline template
   * JSON (the shape returned by /api/companies/:id/template-export).
   * `inlineTemplate` wins if both are provided.
   */
  templateId?: string;
  inlineTemplate?: CompanyTemplate;
  /** Company name override. Defaults to template.name if not provided. */
  companyName?: string;
  /**
   * User id to register as the company owner. Required so the user can
   * immediately see the company in their sidebar.
   */
  ownerUserId: string;
  /**
   * Provider strategy applied across all agents. Defaults to "mixed" which
   * respects each template's per-agent family preference order.
   */
  providerStrategy?: ProviderStrategy;
  /**
   * Optional per-agent overrides keyed by agent.key. Lets the onboarding UI
   * tweak budget caps per agent before spawn.
   */
  agentOverrides?: Record<string, { budgetUsd?: number }>;
};

export type SpawnFromTemplateResult = {
  companyId: string;
  templateId: string;
  agentsCreated: number;
  goalsCreated: number;
  projectsCreated: number;
  issuesCreated: number;
  /**
   * Snapshot of which adapter + model each agent was spawned with. Useful
   * for the UI to show "your agents are running on X".
   */
  adaptersUsed: Record<string, ResolvedAdapter>;
};

export function templateSpawnService(db: Db) {
  async function spawn(input: SpawnFromTemplateInput): Promise<SpawnFromTemplateResult> {
    let template: CompanyTemplate | null = null;
    if (input.inlineTemplate) {
      template = input.inlineTemplate;
    } else if (input.templateId) {
      template = getTemplate(input.templateId);
    }
    if (!template) {
      throw notFound(
        input.templateId
          ? `Unknown template: ${input.templateId}`
          : "spawn requires either templateId or inlineTemplate",
      );
    }
    assertTemplateShape(template);

    // Resolve provider/adapter for every agent BEFORE starting the
    // transaction — if the user has no credentials for the requested
    // strategy, fail fast with a clear error rather than rolling back a
    // half-inserted company.
    const strategy = input.providerStrategy ?? "mixed";
    const apiKeys = instanceApiKeysService(db);
    const storedFamilies = await apiKeys.listConfiguredFamilies();
    const availability = getProviderAvailability(storedFamilies);
    if (!availability.anyConfigured) {
      throw unprocessable(
        "No AI provider credentials configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or install the claude / codex / gemini CLI, before spawning a company.",
      );
    }
    const resolveResult = resolveAgentAdaptersBatch({
      agents: template.agents.map((a) => ({ key: a.key, preference: a.provider })),
      availability,
      strategy,
    });
    if (!resolveResult.ok) {
      throw unprocessable(
        `Cannot spawn template "${template.id}": agent "${resolveResult.failingAgentKey}" needs ${resolveResult.error.wantedFamilies.join(" or ")}, but no matching credentials are configured. ${resolveResult.error.message}`,
      );
    }
    const adaptersByKey = resolveResult.resolved;

    return db.transaction(async (tx) => {
      // 1. Company
      const companyName = input.companyName?.trim() || template.name;
      const [company] = await tx
        .insert(companies)
        .values({
          name: companyName,
          description: template.summary,
          status: "active",
          issuePrefix: await pickUniquePrefix(tx, template.issuePrefix),
          budgetMonthlyCents: template.budgetUsd * 100,
          metrics: template.metrics,
        })
        .returning();
      if (!company) throw new Error("Failed to create company row");
      const companyId = company.id;

      // 2. Owner membership so the user sees it in their sidebar
      await tx.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: input.ownerUserId,
        status: "active",
        membershipRole: "owner",
      });

      // 3. Agents — two-pass to resolve reports-to
      const overrides = input.agentOverrides ?? {};
      const keyToAgentId = new Map<string, string>();

      for (const a of template.agents) {
        const ov = overrides[a.key] ?? {};
        const resolved = adaptersByKey[a.key];
        if (!resolved) {
          throw new Error(`Adapter resolver did not return a result for agent "${a.key}"`);
        }
        const [row] = await tx
          .insert(agents)
          .values({
            companyId,
            name: a.name,
            role: a.role,
            title: a.title,
            icon: a.icon ?? "🤖",
            status: "idle",
            capabilities: a.capabilities,
            adapterType: resolved.adapterType,
            adapterConfig: buildAgentAdapterConfig(a, resolved),
            budgetMonthlyCents: (ov.budgetUsd ?? a.budgetUsd) * 100,
          })
          .returning({ id: agents.id });
        if (!row) throw new Error(`Failed to insert agent ${a.key}`);
        keyToAgentId.set(a.key, row.id);
      }

      for (const a of template.agents) {
        if (!a.reportsTo) continue;
        const parentId = keyToAgentId.get(a.reportsTo);
        const selfId = keyToAgentId.get(a.key);
        if (!parentId || !selfId) {
          throw unprocessable(
            `Template ${template.id}: agent "${a.key}" reports to unknown agent "${a.reportsTo}"`,
          );
        }
        await tx.update(agents).set({ reportsTo: parentId }).where(eq(agents.id, selfId));
      }

      // 4. Goals
      const goalKeyToId = new Map<string, string>();
      for (const g of template.goals) {
        const ownerAgentId = keyToAgentId.get(g.ownerKey);
        if (!ownerAgentId) {
          throw unprocessable(
            `Template ${template.id}: goal "${g.key}" owned by unknown agent "${g.ownerKey}"`,
          );
        }
        const [row] = await tx
          .insert(goals)
          .values({
            companyId,
            title: g.title,
            description: g.description,
            level: "company",
            status: "active",
            ownerAgentId,
          })
          .returning({ id: goals.id });
        if (row) goalKeyToId.set(g.key, row.id);
      }

      // 5. Projects
      const projectKeyToId = new Map<string, string>();
      for (const p of template.projects) {
        const goalId = goalKeyToId.get(p.goalKey);
        const leadAgentId = keyToAgentId.get(p.leadKey);
        if (!goalId || !leadAgentId) {
          throw unprocessable(
            `Template ${template.id}: project "${p.key}" has invalid goal/lead references`,
          );
        }
        const [row] = await tx
          .insert(projects)
          .values({
            companyId,
            goalId,
            name: p.name,
            description: p.description,
            status: "in_progress",
            leadAgentId,
          })
          .returning({ id: projects.id });
        if (row) projectKeyToId.set(p.key, row.id);
      }

      // 6. Issues
      const firstAgentId = keyToAgentId.get(template.agents[0]?.key ?? "") ?? null;
      let issuesInserted = 0;
      for (const i of template.issues) {
        const projectId = projectKeyToId.get(i.projectKey);
        if (!projectId) continue;
        const project = template.projects.find((p) => p.key === i.projectKey);
        const goalId = project ? goalKeyToId.get(project.goalKey) : undefined;
        const assigneeAgentId = i.assigneeKey ? keyToAgentId.get(i.assigneeKey) : undefined;
        await tx.insert(issues).values({
          companyId,
          projectId,
          goalId: goalId ?? null,
          title: i.title,
          description: i.description,
          status: i.status ?? "backlog",
          priority: i.priority ?? "medium",
          assigneeAgentId: assigneeAgentId ?? null,
          createdByAgentId: firstAgentId,
        });
        issuesInserted++;
      }

      return {
        companyId,
        templateId: template.id,
        agentsCreated: template.agents.length,
        goalsCreated: template.goals.length,
        projectsCreated: template.projects.length,
        issuesCreated: issuesInserted,
        adaptersUsed: adaptersByKey,
      };
    });
  }

  return { spawn };
}

// ──────────────────────────────────────────────────────────────────────────

export function assertTemplateShape(template: CompanyTemplate) {
  if (template.agents.length === 0) {
    throw unprocessable(`Template "${template.id}" has no agents`);
  }
  const agentKeys = new Set(template.agents.map((a) => a.key));
  if (agentKeys.size !== template.agents.length) {
    throw unprocessable(`Template "${template.id}" has duplicate agent keys`);
  }
  const goalKeys = new Set(template.goals.map((g) => g.key));
  if (goalKeys.size !== template.goals.length) {
    throw unprocessable(`Template "${template.id}" has duplicate goal keys`);
  }
  const projectKeys = new Set(template.projects.map((p) => p.key));
  if (projectKeys.size !== template.projects.length) {
    throw unprocessable(`Template "${template.id}" has duplicate project keys`);
  }
}

/**
 * Build the adapter_config JSONB payload for a spawned agent. Fields vary
 * by adapter family but they all need the task-oriented prompt + per-run
 * turn cap; CLI adapters additionally need dangerouslySkipPermissions so
 * Claude/Codex/Gemini run headless.
 */
function buildAgentAdapterConfig(
  a: TemplateAgentSeed,
  resolved: ResolvedAdapter,
): Record<string, unknown> {
  const base = {
    model: resolved.model,
    maxTurnsPerRun: a.maxTurnsPerRun ?? 30,
    promptTemplate: a.heartbeatPrompt,
  };
  if (resolved.execution === "cli") {
    return { ...base, dangerouslySkipPermissions: true };
  }
  return base;
}

async function pickUniquePrefix(
  tx: Pick<Db, "select">,
  base: string,
): Promise<string> {
  const candidates = [base, ...Array.from({ length: 99 }, (_, i) => `${base}${i + 1}`)];
  for (const candidate of candidates) {
    const rows = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.issuePrefix, candidate))
      .limit(1);
    if (rows.length === 0) return candidate;
  }
  throw new Error(`Could not allocate unique issue prefix from base "${base}"`);
}
