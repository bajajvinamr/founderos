#!/usr/bin/env node
/**
 * `pnpm seed:demo` — rich demo seed for a local FounderOS instance.
 *
 * Populates a single demo company ("Little Wins") with a believable, rich,
 * interview-showable dataset: team, 6-week run history, decisions, wraps,
 * monthly review, company memory, 3 "connected" integrations, and live goals.
 *
 * Usage:
 *   pnpm seed:demo             # idempotent — skips if Little Wins already present
 *   pnpm seed:demo --reset     # wipe + re-seed (prompts for confirmation unless --yes)
 *   pnpm seed:demo --reset --yes
 *
 * DB target:
 *   Uses FOUNDEROS_DATABASE_URL or DATABASE_URL if set. Otherwise falls back
 *   to the embedded-postgres default the repo uses at
 *   `postgres://founderos:founderos@127.0.0.1:54329/founderos`.
 *
 * Exits non-zero with a clear error if Postgres isn't reachable.
 */
import { createInterface } from "node:readline/promises";
import { createDb } from "@founderos/db";
import { randomUUID } from "node:crypto";
import {
  agentSeeds,
  activityTemplates,
  companyCharter,
  companyConfig,
  decisionSeeds,
  goalSeeds,
  integrationSeeds,
  memorySeeds,
  monthlyReviewSeed,
  weeklyWrapSeeds,
} from "./seed/little-wins-data.js";
import {
  findCompanyByName,
  insertActivity,
  insertAgent,
  insertCompany,
  insertDecision,
  insertDocument,
  insertGoal,
  insertIntegration,
  insertIntegrationData,
  insertIssue,
  insertMemory,
  insertProject,
  wipeCompanyCascade,
} from "./seed/seed-helpers.js";

// ────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ────────────────────────────────────────────────────────────────────────────

type Flags = {
  reset: boolean;
  yes: boolean;
};

function parseFlags(argv: readonly string[]): Flags {
  return {
    reset: argv.includes("--reset"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

const DEFAULT_EMBEDDED_URL =
  "postgres://founderos:founderos@127.0.0.1:54329/founderos";

function resolveDatabaseUrl(): { url: string; source: string } {
  const founderOS = process.env.FOUNDEROS_DATABASE_URL?.trim();
  if (founderOS) return { url: founderOS, source: "FOUNDEROS_DATABASE_URL" };
  const generic = process.env.DATABASE_URL?.trim();
  if (generic) return { url: generic, source: "DATABASE_URL" };
  return {
    url: DEFAULT_EMBEDDED_URL,
    source: "embedded-postgres default (127.0.0.1:54329)",
  };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { url, source } = resolveDatabaseUrl();

  console.log(`[seed:demo] DB target: ${source}`);

  const db = createDb(url);

  // Step 1 — idempotency check.
  let existing: { id: string } | null;
  try {
    existing = await findCompanyByName(db, companyConfig.name);
  } catch (error) {
    console.error(
      `[seed:demo] Could not reach the database (${source}). Start Postgres or set FOUNDEROS_DATABASE_URL, then re-run.`,
    );
    console.error(`[seed:demo] Underlying error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (existing && !flags.reset) {
    console.log(
      `[seed:demo] '${companyConfig.name}' already exists (id=${existing.id}). Nothing to do. Pass --reset to wipe + re-seed.`,
    );
    process.exit(0);
  }

  if (existing && flags.reset) {
    if (!flags.yes) {
      const confirmed = await confirm(
        `[seed:demo] --reset will DELETE the existing '${companyConfig.name}' company (id=${existing.id}) and all its data. Proceed? (y/N) `,
      );
      if (!confirmed) {
        console.log("[seed:demo] Aborted.");
        process.exit(0);
      }
    }
    console.log(`[seed:demo] Wiping existing Little Wins (id=${existing.id})…`);
    await wipeCompanyCascade(db, existing.id);
  }

  // Step 2 — insert company.
  const company = await insertCompany(db, {
    name: companyConfig.name,
    description: companyConfig.description,
    issuePrefix: companyConfig.issuePrefix,
    metrics: companyConfig.metrics,
  });
  console.log(`[seed:demo]   ✓ company inserted (id=${company.id})`);

  // Step 3 — insert agents. The CEO row has `reports_to = NULL` so we insert
  // it first, then wire subordinates. (The company charter is inserted
  // AFTER agents so the document's created_by_agent_id FK resolves.)
  const agentsByName = new Map<string, { id: string; name: string }>();
  // First pass: insert all agents that do not report to anyone (CEO only).
  for (const seed of agentSeeds.filter((a) => !a.reportsTo)) {
    const inserted = await insertAgent(db, {
      companyId: company.id,
      name: seed.name,
      role: seed.role,
      title: seed.title,
      icon: seed.icon,
      status: seed.status,
      budgetUsd: seed.budgetUsd,
      capabilities: seed.capabilities,
      charter: seed.charter,
    });
    agentsByName.set(seed.name, inserted);
  }
  // Second pass: insert reports.
  for (const seed of agentSeeds.filter((a) => !!a.reportsTo)) {
    const boss = seed.reportsTo ? agentsByName.get(seed.reportsTo) : undefined;
    const inserted = await insertAgent(db, {
      companyId: company.id,
      name: seed.name,
      role: seed.role,
      title: seed.title,
      icon: seed.icon,
      status: seed.status,
      budgetUsd: seed.budgetUsd,
      capabilities: seed.capabilities,
      charter: seed.charter,
      reportsToAgentId: boss?.id,
    });
    agentsByName.set(seed.name, inserted);
  }
  console.log(`[seed:demo]   ✓ ${agentsByName.size} agents inserted`);

  const cosAgent = agentsByName.get("Sage");
  if (!cosAgent) throw new Error("Sage (CoS) not found after insert");

  // Step 4 — insert the charter now that we have a valid author id.
  await insertDocument(db, {
    companyId: company.id,
    title: "Company Charter — Little Wins",
    body: companyCharter,
    createdByAgentId: cosAgent.id,
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
  });
  console.log(`[seed:demo]   ✓ charter document inserted`);

  // Step 5 — goals + projects + sub-task issues.
  let issueCount = 0;
  for (const goalSeed of goalSeeds) {
    const owner = agentsByName.get(goalSeed.ownerAgent);
    if (!owner) throw new Error(`Goal owner ${goalSeed.ownerAgent} not found`);
    const goal = await insertGoal(db, {
      companyId: company.id,
      title: goalSeed.title,
      description: goalSeed.description,
      ownerAgentId: owner.id,
    });
    const project = await insertProject(db, {
      companyId: company.id,
      goalId: goal.id,
      name: goalSeed.projectName,
      description: goalSeed.description,
      leadAgentId: owner.id,
    });
    for (const sub of goalSeed.subtasks) {
      const assignee = agentsByName.get(sub.assigneeAgent);
      if (!assignee) throw new Error(`Assignee ${sub.assigneeAgent} not found for sub-task`);
      await insertIssue(db, {
        companyId: company.id,
        projectId: project.id,
        goalId: goal.id,
        title: sub.title,
        description: sub.description,
        status: sub.status,
        priority: sub.priority,
        assigneeAgentId: assignee.id,
        createdByAgentId: owner.id,
      });
      issueCount += 1;
    }
  }
  console.log(`[seed:demo]   ✓ ${goalSeeds.length} goals + ${issueCount} sub-task issues`);

  // Step 6 — decision inbox (approvals table).
  const now = Date.now();
  for (const decision of decisionSeeds) {
    const requester = agentsByName.get(decision.requestedByAgent);
    if (!requester) throw new Error(`Decision requester ${decision.requestedByAgent} not found`);
    await insertDecision(db, {
      companyId: company.id,
      type: decision.type,
      title: decision.title,
      summary: decision.summary,
      body: decision.body,
      status: decision.status,
      requestedByAgentId: requester.id,
      decisionNote: decision.decisionNote,
      createdAt: new Date(now - decision.daysAgo * 24 * 60 * 60 * 1000),
    });
  }
  console.log(
    `[seed:demo]   ✓ ${decisionSeeds.length} decisions (${decisionSeeds.filter((d) => d.status === "approved").length} approved, ${decisionSeeds.filter((d) => d.status === "rejected").length} rejected, ${decisionSeeds.filter((d) => d.status === "pending").length} pending)`,
  );

  // Step 7 — weekly wraps (stored as documents).
  for (const wrap of weeklyWrapSeeds) {
    await insertDocument(db, {
      companyId: company.id,
      title: wrap.title,
      body: wrap.body,
      createdByAgentId: cosAgent.id,
      createdAt: new Date(now - wrap.weeksAgo * 7 * 24 * 60 * 60 * 1000),
    });
  }
  console.log(`[seed:demo]   ✓ ${weeklyWrapSeeds.length} weekly wraps`);

  // Step 8 — monthly review (also a document).
  await insertDocument(db, {
    companyId: company.id,
    title: monthlyReviewSeed.title,
    body: monthlyReviewSeed.body,
    createdByAgentId: cosAgent.id,
    createdAt: new Date(now - 12 * 24 * 60 * 60 * 1000),
  });
  console.log(`[seed:demo]   ✓ 1 monthly review`);

  // Step 9 — company memory.
  for (const mem of memorySeeds) {
    await insertMemory(db, {
      companyId: company.id,
      kind: mem.kind,
      title: mem.title,
      body: mem.body,
      topic: mem.topic,
      pinned: mem.pinned,
      occurredAt: new Date(now - mem.daysAgo * 24 * 60 * 60 * 1000),
    });
  }
  console.log(`[seed:demo]   ✓ ${memorySeeds.length} company-memory entries`);

  // Step 10 — integrations + their cached data.
  let integrationDataCount = 0;
  for (const integration of integrationSeeds) {
    const inserted = await insertIntegration(db, {
      companyId: company.id,
      kind: integration.kind,
      keyHint: integration.keyHint,
      config: integration.config,
    });
    for (const d of integration.data) {
      await insertIntegrationData(db, {
        companyId: company.id,
        integrationId: inserted.id,
        kind: d.kind,
        payload: d.payload,
      });
      integrationDataCount += 1;
    }
  }
  console.log(
    `[seed:demo]   ✓ ${integrationSeeds.length} integrations + ${integrationDataCount} data rows`,
  );

  // Step 11 — activity log (spread across 6 weeks).
  const sixWeeksMs = 6 * 7 * 24 * 60 * 60 * 1000;
  let activityInserted = 0;
  // Shuffle deterministically so the demo spread feels natural but isn't
  // purely random at runtime — gives interview-mode reruns the same shape.
  const shuffled = [...activityTemplates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    // Linear-congruential shuffle keyed off a fixed seed for stability.
    const j = (i * 2654435761) % (i + 1);
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  for (let i = 0; i < shuffled.length; i++) {
    const template = shuffled[i]!;
    const agent = agentsByName.get(template.agent);
    if (!agent) {
      console.warn(`[seed:demo]   ! skipping activity for unknown agent '${template.agent}'`);
      continue;
    }
    const createdAt = new Date(
      now - (i / shuffled.length) * sixWeeksMs - Math.floor(Math.random() * 60 * 60 * 1000),
    );
    await insertActivity(db, {
      companyId: company.id,
      agentId: agent.id,
      action: template.action,
      entityType: template.entityType,
      entityId: randomUUID(),
      detail: template.detail,
      createdAt,
    });
    activityInserted += 1;
  }
  console.log(`[seed:demo]   ✓ ${activityInserted} activity events (6-week spread)`);

  // Step 12 — summary.
  console.log("");
  console.log(`[seed:demo] Done. '${companyConfig.name}' is ready.`);
  console.log(`[seed:demo]   company id:     ${company.id}`);
  console.log(`[seed:demo]   agents:         ${agentsByName.size}`);
  console.log(`[seed:demo]   goals:          ${goalSeeds.length}`);
  console.log(`[seed:demo]   issues:         ${issueCount}`);
  console.log(`[seed:demo]   decisions:      ${decisionSeeds.length}`);
  console.log(`[seed:demo]   weekly wraps:   ${weeklyWrapSeeds.length}`);
  console.log(`[seed:demo]   monthly review: 1`);
  console.log(`[seed:demo]   memory:         ${memorySeeds.length}`);
  console.log(`[seed:demo]   integrations:   ${integrationSeeds.length} (+ ${integrationDataCount} data rows)`);
  console.log(`[seed:demo]   activity:       ${activityInserted}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[seed:demo] Failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
