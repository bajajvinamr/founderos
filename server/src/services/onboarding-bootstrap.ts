/**
 * Atomic onboarding bootstrap orchestrator (issue #11).
 *
 * Wraps every persistent step of `POST /api/onboarding/bootstrap` inside
 * one `db.transaction`, so a failure at agent 4 does NOT leave behind
 * an orphan company / membership / secret / goal / project.
 *
 * Why this exists as a separate module:
 *   - The route handler at `server/src/routes/onboarding.ts` previously
 *     called six service factories in sequence with no outer transaction.
 *     Each service used `db.transaction` *internally*, but a failure
 *     after step N committed steps 1..N-1 unrecoverably.
 *   - Service factories close over their `db` argument at construction
 *     time. To run them inside a transaction we re-instantiate each
 *     factory with `tx` instead of `db`. Drizzle's `tx` is structurally
 *     compatible with `Db` for the query interface, so the service
 *     code re-uses the same paths.
 *   - The Anthropic key live-API check stays *outside* the transaction
 *     because external network calls hold tx resources for too long.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, workspaceDepartments } from "@founderos/db";
import type { AgentRole } from "@founderos/shared";
import {
  accessService,
  agentService,
  companyMemoryService,
  companyService,
  goalService,
  logActivity,
  projectService,
  secretService,
} from "./index.js";
import { logger } from "../middleware/logger.js";
import { runFirstRunForCompany } from "./onboarding/first-run.js";

/**
 * S3.10 — Magic activation gate (10-min first-value). When a founder finishes
 * onboarding with at least this many integrations connected, we kick off the
 * first-run orchestrator (parallel backfill → agent warmup → daily brief →
 * inbox announcement). Below the threshold there is too little signal to
 * generate a useful brief, so we skip and let the 7am cron handle it.
 */
const FIRST_RUN_INTEGRATION_THRESHOLD = 2;

// S1.9 — onboarding always provisions these 5 core departments. Migration
// 0075 backfills them for already-existing companies; new companies get
// rows written here. Source of truth for the core list lives in
// `packages/db/src/migrations/0075_departments.sql` (is_core = true).
const CORE_DEPARTMENT_IDS = [
  "chief-of-staff",
  "growth",
  "content",
  "crm",
  "finance",
] as const;
const NON_CORE_DEPARTMENT_IDS = ["engineering", "ops"] as const;
type NonCoreDepartmentId = (typeof NON_CORE_DEPARTMENT_IDS)[number];

export const AGENT_SLOTS = ["cos", "growth", "content", "finance"] as const;
export type AgentSlot = (typeof AGENT_SLOTS)[number];

/**
 * Council 2026-05-05 P2 (TC-2) — Analytics integrations required to populate
 * the GrowthConsole on a paid plan. The list is intentionally narrow: the S3
 * demo metric ("32% of signups from LinkedIn") needs paid-conversion (Stripe),
 * funnel events (PostHog), and source attribution (LinkedIn). Slack / Notion /
 * HubSpot are useful but do not satisfy the analytics-milestone gate — they
 * power different surfaces (Inbox / docs / CRM).
 *
 * Used in two places:
 *   1. `server/src/routes/onboarding.ts` — bootstrap rejects when active
 *      subscription + no flag in this set is true.
 *   2. `ui/src/pages/departments/AnalyticsConnectPrompt.tsx` — the matching
 *      UI surface lists exactly these three connectors.
 */
export const ANALYTICS_INTEGRATION_KEYS = [
  "stripe",
  "posthog",
  "linkedin",
] as const;
export type AnalyticsIntegrationKey = (typeof ANALYTICS_INTEGRATION_KEYS)[number];

const SLOT_TO_ROLE: Record<AgentSlot, AgentRole> = {
  cos: "ceo",
  growth: "cmo",
  content: "general",
  finance: "cfo",
};

const ANTHROPIC_SECRET_NAME = "ANTHROPIC_API_KEY";

export type BootstrapCharter = {
  slot: AgentSlot;
  name: string;
  title: string;
  avatar?: string;
  charter: string;
  firstPriority: string;
};

export type BootstrapInput = {
  vision: string;
  bottlenecks: string[];
  team: "solo" | "cofounder" | "small_team";
  cofounder?: { name: string | null; email: string | null } | null;
  adapterChoice: "claude_local" | "anthropic_api" | "skip";
  anthropicKey: string;
  integrations?: Record<string, boolean>;
  /** S1.9 — non-core departments the founder opted in to (engineering, ops). */
  nonCoreDepartments?: NonCoreDepartmentId[];
  /** S1.9 — initial autonomy level applied to every enabled department. */
  autonomyLevel?: number;
  charters: Record<AgentSlot, BootstrapCharter>;
  companyName: string;
};

export type BootstrapContext = {
  actorUserId: string;
};

export type BootstrapResult = {
  companyId: string;
  companyPrefix: string;
  agentIdsBySlot: Record<AgentSlot, string>;
  goalId: string | null;
  projectId: string;
  /**
   * S3.10 — first-run orchestrator promise. Set after the bootstrap
   * transaction commits. Tests can await it; the production HTTP handler
   * leaves it un-awaited (fire-and-forget) and the UI polls
   * /api/companies/:companyId/first-run-progress for status.
   */
  firstRunPromise?: Promise<unknown | null>;
};

function clampAutonomy(raw: number): number {
  if (!Number.isFinite(raw)) return 2;
  const rounded = Math.round(raw);
  if (rounded < 1) return 1;
  if (rounded > 4) return 4;
  return rounded;
}

function buildAgentAdapterConfig(anthropicSecretId: string | null) {
  if (!anthropicSecretId) return { env: {} };
  return {
    env: {
      ANTHROPIC_API_KEY: {
        type: "secret_ref" as const,
        secretId: anthropicSecretId,
        version: "latest" as const,
      },
    },
  };
}

/**
 * Atomic bootstrap. All persistent state (company, membership, secret,
 * goal, project, memory entries, agents, audit log) is created in one
 * transaction. If any step throws the entire transaction rolls back —
 * leaving zero rows in any of those tables for this run.
 *
 * Memory writes are wrapped in `.catch(() => null)` to preserve the
 * historical "memory writes are non-critical" semantics: a failed
 * memory insert does not abort the bootstrap. Every other write is
 * load-bearing and a throw rolls back the whole orchestration.
 *
 * The Anthropic key live-API check belongs to the caller (route
 * handler) — external network I/O has no place inside a database
 * transaction. The orchestrator assumes the key (if any) is already
 * validated.
 */
export async function bootstrapCompanyOnboarding(
  db: Db,
  input: BootstrapInput,
  context: BootstrapContext,
): Promise<BootstrapResult> {
  const result: BootstrapResult = await db.transaction(async (tx) => {
    // tx is structurally compatible with Db for query operations.
    // Cast lets the existing service factories re-bind to tx without
    // touching their signatures.
    const txDb = tx as unknown as Db;

    const companies = companyService(txDb);
    const access = accessService(txDb);
    const secrets = secretService(txDb);
    const agents = agentService(txDb);
    const goals = goalService(txDb);
    const projects = projectService(txDb);
    const memory = companyMemoryService(txDb);

    // 1. Company row + owner membership. Note: companyService.create
    //    has an internal retry loop for issue-prefix conflicts. That
    //    loop relies on each attempt being its own implicit transaction
    //    — inside our outer tx, the first conflict aborts the entire
    //    tx and subsequent retry inserts fail with "current transaction
    //    is aborted". This means a true prefix collision during
    //    concurrent bootstraps will fail atomically (no orphan rows)
    //    but will NOT auto-retry. Acceptable for company creation
    //    (rare event); the founder retries with a different name.
    const company = await companies.create({ name: input.companyName });
    await access.ensureMembership(
      company.id,
      "user",
      context.actorUserId,
      "owner",
      "active",
    );

    // S1.9 — workspace_departments rows for this new company. The 5 core
    // departments are always provisioned. Non-core (engineering, ops) are
    // included only if the founder opted in. Single workspace-wide autonomy
    // level applies to all rows in v1; founders can fine-tune per-department
    // later via the API. Migration 0075 backfills already-existing companies
    // — this insert handles new ones.
    const autonomyLevel = clampAutonomy(input.autonomyLevel ?? 2);
    const optedInNonCore = (input.nonCoreDepartments ?? []).filter(
      (d): d is NonCoreDepartmentId =>
        (NON_CORE_DEPARTMENT_IDS as readonly string[]).includes(d),
    );
    const enabledDepartmentIds = [...CORE_DEPARTMENT_IDS, ...optedInNonCore];
    await txDb.insert(workspaceDepartments).values(
      enabledDepartmentIds.map((departmentId) => ({
        companyId: company.id,
        departmentId,
        enabled: true,
        autonomyLevel,
      })),
    );

    // 2. Anthropic key as a company secret (only when the founder
    //    provided one). claude_local + skip don't need a stored key.
    const secret =
      input.adapterChoice === "anthropic_api" && input.anthropicKey
        ? await secrets.create(
            company.id,
            {
              name: ANTHROPIC_SECRET_NAME,
              provider: "local_encrypted",
              value: input.anthropicKey,
              description: "Auto-saved during FounderOS onboarding",
            },
            { userId: context.actorUserId },
          )
        : null;

    // 3. Company goal + onboarding project.
    const goal = await goals.create(company.id, {
      title: `Ship ${input.companyName}`,
      description: input.vision,
      level: "company",
      status: "active",
    });

    const project = await projects.create(company.id, {
      name: "Onboarding",
      status: "in_progress",
      goalIds: goal ? [goal.id] : [],
    });

    // 4. Founder vision → company memory. Non-critical; failures
    //    must not abort the bootstrap (preserves prior behavior).
    await memory
      .create(company.id, {
        kind: "founder_note",
        title: "Founder vision (onboarding)",
        body: input.vision,
        topic: "vision",
        pinned: true,
        source: "manual",
      })
      .catch(() => null);
    await memory
      .create(company.id, {
        kind: "founder_note",
        title: "Current bottlenecks (onboarding)",
        body: `Bottlenecks: ${input.bottlenecks.join(", ")}\nTeam shape: ${input.team}`,
        topic: "focus",
        pinned: false,
        source: "manual",
      })
      .catch(() => null);

    // 5. Provision four agents with charters.
    const adapterConfig = buildAgentAdapterConfig(secret?.id ?? null);
    // BYO-107 (ADR-011) — flag-aware adapter selection.
    //
    // Pre-flag: hardcoded "claude_local" for ALL choices. The 2026-04 P1 fix
    //   intentionally collapsed "anthropic_api" → "claude_local" because no
    //   "claude_api" adapter is registered (would produce broken agents). On
    //   Fly this still doesn't actually execute (no claude CLI in container),
    //   but at least the row shape is valid and local-dev installs work.
    //
    // Post-flag (FOUNDEROS_BYO_RUNNER_ENABLED=1): map ALL choices to
    //   "byo_runner". The cloud enqueues runner_jobs rows and the founder's
    //   local @founderos/runner picks them up — closing the 7-month-old
    //   "agents can't actually run on hosted Fly" gap.
    //
    //   `anthropic_api` keeps storing the user's key as a company secret
    //   above; the runner can read it later if a flow needs direct API calls,
    //   but the agent execution itself is via the local claude CLI under the
    //   founder's authed session (which they pay for via Pro).
    const { isByoRunnerEnabled } = await import("../lib/byo-runner-flag.js");
    const adapterType = isByoRunnerEnabled() ? "byo_runner" : "claude_local";
    const agentIdsBySlot: Record<AgentSlot, string> = {
      cos: "",
      growth: "",
      content: "",
      finance: "",
    };

    for (const slot of AGENT_SLOTS) {
      const charter = input.charters[slot];
      const role = SLOT_TO_ROLE[slot];
      const agent = await agents.create(company.id, {
        name: charter.name,
        role,
        title: charter.title,
        capabilities: charter.charter,
        adapterType,
        adapterConfig,
        status: "idle",
        spentMonthlyCents: 0,
        budgetMonthlyCents: 0,
      });
      agentIdsBySlot[slot] = agent.id;
    }

    // 6. Audit log entry inside the same transaction so the row only
    //    exists if the company was actually created.
    await logActivity(txDb, {
      companyId: company.id,
      actorType: "user",
      actorId: context.actorUserId,
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: {
        source: "founder_onboarding_v2",
        bottlenecks: input.bottlenecks,
        team: input.team,
      },
    });

    return {
      companyId: company.id,
      companyPrefix: company.issuePrefix,
      agentIdsBySlot,
      goalId: goal?.id ?? null,
      projectId: project.id,
    };
  });

  // ── S3.10 — magic activation gate ────────────────────────────────────────
  //
  // Outside the transaction so a slow first-run does not hold tx locks. The
  // promise is returned (not voided) so a caller — usually a test, sometimes
  // a worker that wants to deliver a synchronous "first brief ready" toast
  // — can await it. The HTTP route handler in routes/onboarding.ts treats
  // the returned promise as fire-and-forget (`void result.firstRunPromise`)
  // because the founder's wizard is already showing the loading screen.
  result.firstRunPromise = maybeTriggerFirstRun(db, result.companyId);

  return result;
}

/**
 * Evaluates the integration gate and (when ≥ threshold) kicks off the
 * first-run orchestrator. Returns a promise that resolves once the run
 * completes — or resolves immediately to `null` when the gate did not fire.
 */
async function maybeTriggerFirstRun(
  db: Db,
  companyId: string,
): Promise<unknown | null> {
  try {
    const connectedRows = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.companyId, companyId),
          eq(integrations.status, "connected"),
        ),
      );
    if (connectedRows.length < FIRST_RUN_INTEGRATION_THRESHOLD) {
      logger.info(
        {
          companyId,
          connected: connectedRows.length,
          threshold: FIRST_RUN_INTEGRATION_THRESHOLD,
        },
        "onboarding-bootstrap: skipping first-run — too few integrations connected",
      );
      return null;
    }

    return await runFirstRunForCompany(db, companyId).catch((err: unknown) => {
      logger.error(
        { err, companyId },
        "onboarding-bootstrap: first-run orchestrator threw",
      );
      return null;
    });
  } catch (err) {
    logger.warn(
      { err, companyId },
      "onboarding-bootstrap: failed to evaluate first-run gate (non-fatal)",
    );
    return null;
  }
}
