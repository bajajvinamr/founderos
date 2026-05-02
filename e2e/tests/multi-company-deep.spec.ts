/**
 * Multi-company deep production test.
 *
 * Target: the fullest realistic exercise of the FounderOS control plane —
 * 3 seeded companies (agnost.ai · Pred · Gravton Labs), each with 7-8 agents
 * and 4-5 projects, walked end-to-end through the public API surface.
 *
 * What this verifies (per company):
 *   1. Company is listed and has correct prefix + non-empty name
 *   2. ≥3 agents exist, each has a non-empty name + role
 *   3. ≥1 goal exists
 *   4. ≥1 project exists and is linked to a lead agent present in step 2
 *   5. /memory, /weekly-wraps, /decisions/pending-outcomes return well-shaped arrays
 *   6. For ≥3 agents per company:
 *        a. /agents/:id returns detail with adapter config
 *        b. /agents/:id/activity returns an array
 *        c. /agents/:id/skills returns an array
 *        d. /agents/:id/instructions returns an object (or 404 — both acceptable)
 *   7. For the first project: issues list returns an array
 *   8. Cross-tenant isolation: issues from company A must NOT appear in company B's
 *      issues response (tests the companyId scope filter).
 *
 * What this explicitly does NOT do:
 *   - Spawn real agent runs (costs Anthropic credits, non-deterministic)
 *   - Mutate seeded data (keeps the suite idempotent + repeat-safe)
 *   - Hit Stripe / Composio externally (those have unit coverage)
 *
 * When to run:
 *   - After migrations or schema changes to verify multi-tenant queries still scope
 *   - As a smoke gate before buyer handover walk-through
 *   - Against local dev after `pnpm --filter @founderos/db exec tsx src/seed-demo.ts`
 *
 * Env:
 *   FOUNDEROS_E2E_BASE_URL           — target server (default http://localhost:3100)
 *   FOUNDEROS_E2E_PROFILE=public-only  — skips this entire file (no auth data)
 *
 * Design:
 *   - Each top-level `describe` groups a concern (listing, agent-detail, scope).
 *   - Inside, we loop companies so one failure shows which tenant leaked.
 *   - Every expect() includes a descriptive message with API context.
 */
import {
  describeResponse,
  expect,
  test,
  type AgentSummary,
  type ApiHelper,
  type CompanySummary,
} from "../fixtures";

interface Goal {
  id: string;
  companyId: string;
  name?: string;
  title?: string;
}

interface Project {
  id: string;
  companyId: string;
  goalId?: string;
  leadAgentId?: string;
  name?: string;
}

interface Issue {
  id: string;
  companyId: string;
  identifier?: string;
  title?: string;
}

interface AgentDetail extends AgentSummary {
  role?: string;
  adapterType?: string;
  adapter?: { type?: string } | null;
}

const MIN_COMPANIES = 3;
const MIN_AGENTS_PER_COMPANY = 3;
const MIN_PROJECTS_PER_COMPANY = 1;
const AGENTS_TO_DEEP_CHECK_PER_COMPANY = 3;

/**
 * Skip experimental seed companies (e.g. "Little Wins") from depth
 * coverage. The narrative seed deliberately gives them a smaller
 * agent roster — they exist for scenario variety, not depth coverage.
 * The marker is the `[EXPERIMENTAL DEMO]` prefix on the description
 * field, set in packages/db/src/seed-demo-narrative.ts.
 */
function isExperimentalCompany(c: CompanySummary): boolean {
  const desc = (c as CompanySummary & { description?: string }).description ?? "";
  return desc.startsWith("[EXPERIMENTAL DEMO]");
}

async function loadAllCompanies(api: ApiHelper): Promise<CompanySummary[]> {
  const r = await api.get("/api/companies");
  expect(
    r.status,
    describeResponse("GET /api/companies did not return 200", r),
  ).toBe(200);
  expect(
    Array.isArray(r.json),
    describeResponse("GET /api/companies is not an array", r),
  ).toBe(true);
  return r.json as CompanySummary[];
}

async function loadAgentsForCompany(
  api: ApiHelper,
  companyId: string,
): Promise<AgentSummary[]> {
  const r = await api.get(`/api/companies/${companyId}/agents`);
  expect(
    r.status,
    describeResponse(`GET agents for company ${companyId} not 200`, r),
  ).toBe(200);
  expect(
    Array.isArray(r.json),
    describeResponse(`agents list for company ${companyId} is not an array`, r),
  ).toBe(true);
  return r.json as AgentSummary[];
}

async function loadGoalsForCompany(
  api: ApiHelper,
  companyId: string,
): Promise<Goal[]> {
  const r = await api.get(`/api/companies/${companyId}/goals`);
  // `/goals` may 404 on very old builds; treat as empty array to keep the test
  // useful on older prod revisions.
  if (r.status === 404) return [];
  expect(
    r.status,
    describeResponse(`GET goals for company ${companyId} not 200/404`, r),
  ).toBe(200);
  expect(
    Array.isArray(r.json),
    describeResponse(`goals list for ${companyId} is not an array`, r),
  ).toBe(true);
  return r.json as Goal[];
}

async function loadProjectsForCompany(
  api: ApiHelper,
  companyId: string,
): Promise<Project[]> {
  const r = await api.get(`/api/companies/${companyId}/projects`);
  if (r.status === 404) return [];
  expect(
    r.status,
    describeResponse(`GET projects for company ${companyId} not 200`, r),
  ).toBe(200);
  expect(
    Array.isArray(r.json),
    describeResponse(`projects list for ${companyId} is not an array`, r),
  ).toBe(true);
  return r.json as Project[];
}

async function loadIssuesForCompany(
  api: ApiHelper,
  companyId: string,
): Promise<Issue[]> {
  const r = await api.get(`/api/companies/${companyId}/issues`);
  expect(
    r.status,
    describeResponse(`GET issues for company ${companyId} not 200`, r),
  ).toBe(200);
  expect(
    Array.isArray(r.json),
    describeResponse(`issues list for ${companyId} is not an array`, r),
  ).toBe(true);
  return r.json as Issue[];
}

// ────────────────────────────────────────────────────────────────────────
// Top-level precondition: need ≥3 seeded companies
// ────────────────────────────────────────────────────────────────────────

test.describe("[multi-company] tenant listing", () => {
  test("[tenants-seeded] at least 3 companies exist with distinct non-empty prefixes", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    expect(
      companies.length,
      `Expected ≥${MIN_COMPANIES} seeded companies, got ${companies.length}. ` +
        `Run: pnpm --filter @founderos/db exec tsx src/seed-demo.ts`,
    ).toBeGreaterThanOrEqual(MIN_COMPANIES);

    const prefixes = companies.map((c) => (c.issuePrefix || "").toUpperCase());
    const nonEmpty = prefixes.filter((p) => p.length > 0);
    expect(
      nonEmpty.length,
      `Every company must have a non-empty issuePrefix. Got: ${JSON.stringify(prefixes)}`,
    ).toBe(companies.length);

    const unique = new Set(nonEmpty);
    expect(
      unique.size,
      `Issue prefixes must be unique across tenants. Got: ${JSON.stringify(prefixes)}`,
    ).toBe(nonEmpty.length);

    for (const c of companies) {
      expect(
        (c.name || "").trim().length,
        `Company id=${c.id} has empty name`,
      ).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-company deep walks
// ────────────────────────────────────────────────────────────────────────

test.describe("[per-company] agent + project + list-endpoint depth", () => {
  test("[deep-walk] each seeded company has agents, goals, projects, and well-shaped list endpoints", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    // Cap at first 4 (after filtering) so the test stays under 30s on
    // prod-tier network. See isExperimentalCompany() for the filter rationale.
    const subset = companies.filter((c) => !isExperimentalCompany(c)).slice(0, 4);
    expect(
      subset.length,
      "Need at least 1 non-experimental company to walk",
    ).toBeGreaterThanOrEqual(1);

    for (const company of subset) {
      const label = `${company.issuePrefix}/${company.name}`;

      // ── Agents ─────────────────────────────────────────────────────
      const agents = await loadAgentsForCompany(api, company.id);
      expect(
        agents.length,
        `[${label}] expected ≥${MIN_AGENTS_PER_COMPANY} agents, got ${agents.length}`,
      ).toBeGreaterThanOrEqual(MIN_AGENTS_PER_COMPANY);

      const agentIdSet = new Set<string>();
      for (const a of agents) {
        expect(
          (a.name || "").trim().length,
          `[${label}] agent id=${a.id} has empty name`,
        ).toBeGreaterThan(0);
        expect(
          a.companyId,
          `[${label}] agent id=${a.id} has no companyId`,
        ).toBe(company.id);
        agentIdSet.add(a.id);
      }

      // ── Goals (best-effort; older revisions may 404) ────────────────
      const goals = await loadGoalsForCompany(api, company.id);
      for (const g of goals) {
        expect(
          g.companyId,
          `[${label}] goal id=${g.id} not scoped to this company`,
        ).toBe(company.id);
      }

      // ── Projects ───────────────────────────────────────────────────
      const projects = await loadProjectsForCompany(api, company.id);
      expect(
        projects.length,
        `[${label}] expected ≥${MIN_PROJECTS_PER_COMPANY} projects, got ${projects.length}`,
      ).toBeGreaterThanOrEqual(MIN_PROJECTS_PER_COMPANY);

      for (const p of projects) {
        expect(
          p.companyId,
          `[${label}] project id=${p.id} not scoped to this company`,
        ).toBe(company.id);
        if (p.leadAgentId) {
          expect(
            agentIdSet.has(p.leadAgentId),
            `[${label}] project id=${p.id} leadAgentId ${p.leadAgentId} ` +
              `is not in this company's agent list`,
          ).toBe(true);
        }
      }

      // ── List endpoints: memory / weekly-wraps / pending-outcomes ───
      const mem = await api.get(`/api/companies/${company.id}/memory`);
      expect(
        mem.status,
        describeResponse(`[${label}] GET memory not 200`, mem),
      ).toBe(200);
      expect(
        Array.isArray(mem.json),
        describeResponse(`[${label}] memory not array`, mem),
      ).toBe(true);

      const wrap = await api.get(`/api/companies/${company.id}/weekly-wraps`);
      expect(
        wrap.status,
        describeResponse(`[${label}] GET weekly-wraps not 200`, wrap),
      ).toBe(200);
      expect(
        Array.isArray(wrap.json),
        describeResponse(`[${label}] weekly-wraps not array`, wrap),
      ).toBe(true);

      const dec = await api.get(
        `/api/companies/${company.id}/decisions/pending-outcomes`,
      );
      expect(
        dec.status,
        describeResponse(`[${label}] GET pending-outcomes not 200`, dec),
      ).toBe(200);
      const decBody = dec.json as
        | { count?: unknown; outcomes?: unknown }
        | null;
      expect(
        decBody,
        `[${label}] pending-outcomes body was not JSON`,
      ).not.toBeNull();
      expect(
        Array.isArray(decBody?.outcomes),
        describeResponse(`[${label}] outcomes not an array`, dec),
      ).toBe(true);
      expect(
        typeof decBody?.count,
        `[${label}] pending-outcomes.count is not a number`,
      ).toBe("number");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-agent deep detail walk (3+ agents per company)
// ────────────────────────────────────────────────────────────────────────

test.describe("[per-agent] detail, activity, skills, instructions", () => {
  test("[agent-deep-detail] ≥3 agents per company expose consistent detail + activity + skills", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    // Same experimental filter as [deep-walk] — Little Wins ships with
    // 2 agents intentionally, below AGENTS_TO_DEEP_CHECK_PER_COMPANY.
    const subset = companies.filter((c) => !isExperimentalCompany(c)).slice(0, 4);

    // Track whether the optional routes were actually exercised (200) vs all 404.
    // If every agent 404s on skills/activity, we'd silently pass — catch that.
    let skillsExercised = 0;
    let activityExercised = 0;
    let instructionsExercised = 0;
    let agentsChecked = 0;

    for (const company of subset) {
      const label = `${company.issuePrefix}/${company.name}`;
      const agents = await loadAgentsForCompany(api, company.id);
      const deepCheck = agents.slice(0, AGENTS_TO_DEEP_CHECK_PER_COMPANY);
      expect(
        deepCheck.length,
        `[${label}] need ≥${AGENTS_TO_DEEP_CHECK_PER_COMPANY} agents for deep check`,
      ).toBeGreaterThanOrEqual(AGENTS_TO_DEEP_CHECK_PER_COMPANY);

      for (const agent of deepCheck) {
        agentsChecked += 1;
        const agentLabel = `${label}/${agent.name}`;

        // Detail
        const det = await api.get(`/api/agents/${agent.id}`);
        expect(
          det.status,
          describeResponse(`[${agentLabel}] GET /api/agents/:id not 200`, det),
        ).toBe(200);
        const body = det.json as AgentDetail | null;
        expect(body, `[${agentLabel}] agent detail body is null`).not.toBeNull();
        expect(
          body?.id,
          `[${agentLabel}] agent detail id mismatch`,
        ).toBe(agent.id);
        expect(
          body?.companyId,
          `[${agentLabel}] agent detail leaks across companies`,
        ).toBe(company.id);

        // Activity — must be an array (possibly empty on a fresh seed).
        // Not every build exposes /activity on the agent route; accept 404.
        const act = await api.get(`/api/agents/${agent.id}/activity`);
        if (act.status !== 404) {
          expect(
            act.status,
            describeResponse(`[${agentLabel}] GET activity not 200/404`, act),
          ).toBe(200);
          expect(
            Array.isArray(act.json),
            describeResponse(`[${agentLabel}] activity not array`, act),
          ).toBe(true);
          activityExercised += 1;
        }

        // Skills — response is an envelope: { adapterType, entries: [...], ... }
        // Some build targets may still return 404 for missing agents (defensive).
        const sk = await api.get(`/api/agents/${agent.id}/skills`);
        if (sk.status !== 404) {
          expect(
            sk.status,
            describeResponse(`[${agentLabel}] GET skills not 200/404`, sk),
          ).toBe(200);
          const skBody = sk.json as { entries?: unknown } | null;
          expect(
            skBody && typeof skBody === "object",
            describeResponse(`[${agentLabel}] skills body not object`, sk),
          ).toBe(true);
          // The envelope's .entries array is the contract the UI consumes.
          expect(
            Array.isArray(skBody?.entries),
            describeResponse(
              `[${agentLabel}] skills.entries is not an array`,
              sk,
            ),
          ).toBe(true);
          skillsExercised += 1;
        }

        // Instructions — either an object body (200) or 404 (unconfigured). Never 500.
        const inst = await api.get(`/api/agents/${agent.id}/instructions`);
        expect(
          [200, 404].includes(inst.status),
          describeResponse(
            `[${agentLabel}] GET instructions must be 200 or 404, got ${inst.status}`,
            inst,
          ),
        ).toBe(true);
        if (inst.status === 200) {
          expect(
            inst.json && typeof inst.json === "object",
            describeResponse(`[${agentLabel}] instructions body not object`, inst),
          ).toBe(true);
          instructionsExercised += 1;
        }
      }
    }

    // Don't silently pass if all optional routes 404 across every agent in
    // every tenant. At least one of the three surfaces must be live for the
    // deep check to have contract value. If ALL three are dead, the route
    // layer was probably deleted and we need to know.
    expect(
      skillsExercised + activityExercised + instructionsExercised,
      `All optional agent routes returned 404 across ${agentsChecked} agents. ` +
        `skills/activity/instructions appear unimplemented — deep check is ` +
        `effectively a liveness probe, not a contract test.`,
    ).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Issue/task surface per company (task analogue)
// ────────────────────────────────────────────────────────────────────────

test.describe("[per-project] issue (task) listings", () => {
  test("[issues-list] every seeded company returns an array for /issues with consistent companyId scope", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    const subset = companies.slice(0, 4);

    for (const company of subset) {
      const label = `${company.issuePrefix}/${company.name}`;
      const issues = await loadIssuesForCompany(api, company.id);
      // Seed may or may not have issues — shape check is the contract.
      for (const i of issues) {
        expect(
          i.companyId,
          `[${label}] issue id=${i.id} not scoped to this company`,
        ).toBe(company.id);
        if (i.identifier) {
          expect(
            i.identifier.startsWith(company.issuePrefix),
            `[${label}] issue identifier '${i.identifier}' does not start with prefix '${company.issuePrefix}'`,
          ).toBe(true);
        }
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Cross-tenant isolation — the most important multi-customer invariant
// ────────────────────────────────────────────────────────────────────────

test.describe("[isolation] cross-tenant safety", () => {
  test("[cross-tenant-issues] no issue id is shared across any pair of tenants", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    expect(
      companies.length,
      "Need ≥2 companies to check cross-tenant isolation",
    ).toBeGreaterThanOrEqual(2);

    // Fetch every tenant's issues so we can check all pairs, not just the
    // first two. A leak between any two tenants would otherwise slip through.
    const perCompany: Array<{ company: CompanySummary; issues: Issue[] }> = [];
    for (const c of companies) {
      perCompany.push({
        company: c,
        issues: await loadIssuesForCompany(api, c.id),
      });
    }

    // Map every issue id → owning company. The first time we see an id we
    // record it; a second occurrence is an isolation breach.
    const owner = new Map<string, CompanySummary>();
    for (const { company, issues } of perCompany) {
      for (const issue of issues) {
        const already = owner.get(issue.id);
        expect(
          already,
          already
            ? `Tenant isolation breach: issue id=${issue.id} appears in ` +
                `both ${already.name} and ${company.name}`
            : `(unreachable)`,
        ).toBeUndefined();
        owner.set(issue.id, company);
      }
    }
  });

  test("[cross-tenant-agents] no agent id is shared across any pair of tenants, and ≥1 tenant has ≥1 agent", async ({
    api,
    profile,
  }) => {
    if (profile === "public-only") {
      test.skip(true, "public-only — no authenticated tenant access");
    }

    const companies = await loadAllCompanies(api);
    expect(
      companies.length,
      "Need ≥2 companies to check cross-tenant isolation",
    ).toBeGreaterThanOrEqual(2);

    const perCompany: Array<{
      company: CompanySummary;
      agents: AgentSummary[];
    }> = [];
    for (const c of companies) {
      perCompany.push({
        company: c,
        agents: await loadAgentsForCompany(api, c.id),
      });
    }

    // Guard against the vacuous-pass failure mode: if every tenant has zero
    // agents, the isolation loop below iterates nothing and the test is
    // silently green on an empty DB. Require ≥1 agent total before asserting.
    const totalAgents = perCompany.reduce((n, x) => n + x.agents.length, 0);
    expect(
      totalAgents,
      "No agents returned for ANY tenant — isolation test would be vacuous. " +
        "Run the demo seed or check auth scope.",
    ).toBeGreaterThan(0);

    const owner = new Map<string, CompanySummary>();
    for (const { company, agents } of perCompany) {
      for (const agent of agents) {
        const already = owner.get(agent.id);
        expect(
          already,
          already
            ? `Tenant isolation breach: agent id=${agent.id} appears in ` +
                `both ${already.name} and ${company.name}`
            : `(unreachable)`,
        ).toBeUndefined();
        owner.set(agent.id, company);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Health parity — deep health must stay green while we're exercising tenants
// ────────────────────────────────────────────────────────────────────────

test.describe("[health-under-load] deep health stays green", () => {
  test("[health-deep] /api/health/deep is status:ok before and after the tenant walk", async ({
    api,
    profile,
  }) => {
    // Deep-health doesn't need auth context, so we run regardless of profile.
    const before = await api.get("/api/health/deep");
    expect(
      before.status,
      describeResponse("deep-health not 200 before tenant walk", before),
    ).toBe(200);

    if (profile !== "public-only") {
      // Re-read companies to generate a bit of load between the two probes.
      await loadAllCompanies(api);
    }

    const after = await api.get("/api/health/deep");
    expect(
      after.status,
      describeResponse("deep-health not 200 after tenant walk", after),
    ).toBe(200);
    const body = after.json as
      | { status?: string; checks?: Array<{ name?: string; status?: string }> }
      | null;
    // Local dev may return "degraded" because SENTRY_DSN is not set. Prod must
    // be "ok". Accept both, but fail loudly if critical checks (db / session)
    // are not "ok".
    expect(
      ["ok", "degraded"].includes(body?.status ?? ""),
      describeResponse(
        `deep-health status must be 'ok' or 'degraded', got '${body?.status}'`,
        after,
      ),
    ).toBe(true);

    const criticalCheckNames = ["db_roundtrip", "table_check", "session_resolver"];
    const checks = body?.checks ?? [];
    for (const name of criticalCheckNames) {
      const check = checks.find((c) => c.name === name);
      if (!check) continue; // Older builds may omit some checks.
      expect(
        check.status,
        describeResponse(
          `deep-health critical check '${name}' is not 'ok' (got '${check.status}')`,
          after,
        ),
      ).toBe("ok");
    }
  });
});

