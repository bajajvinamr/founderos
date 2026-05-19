# AUDIT — Test coverage gap inventory toward 99% line / 95% branch

_Run 2026-05-19. Owner: Claude. Source of truth for: `GOAL-99-percent-e2e-coverage.md` item G1 (baseline)._

> **Headline**: Across 15 workspace packages measured, the codebase sits at roughly **40% weighted line coverage / 67% branch coverage**. The two biggest packages (`server` 55% / `ui` 22%) are the entire story — `runner` (74%), `shared` (79%), and `templates` (99%) are already at the doorstep, and the leaf API-adapters (anthropic/openai/gemini) are 55–62% with small surfaces. **`ui/` is the dominant gap**: 289 of 430 measured files sit under 50% line coverage, almost all page-level components that have no unit-tier sibling test. The honest path to 99/95 is: (a) write component tests for the seven critical-path page components, (b) treat seed scripts + page-level shells + plugin examples as exempt, and (c) accept that without lifting `ui/` from 22% → ~85% the global number cannot move. Council's 80/70 UI floor recommendation is the practical position here.

## 1. Run + report

**Tooling**: `vitest run --coverage --coverage.reporter=json-summary` (v8 provider) run per workspace package. Root `pnpm -w run test:coverage` was avoided to keep the per-package signal isolated (root invocation aggregates and loses per-package totals).

**What ran cleanly**: server (55%, ~12 min), ui (22%, ~3 min), runner, shared, db, cli, mcp-server, templates, and all 7 adapter packages. Each produced `coverage-summary.json` plus per-file line/branch percentages.

**Infrastructure issues observed**:
- v8 provider was stable across all 15 packages. No OOM, no crashes.
- Root `vitest.config.ts` `projects` array still excludes `anthropic-api`, `openai-api`, `pi-local`, `mcp-server`, `templates`, `adapter-utils`, `openclaw-gateway`, `cursor-local`, `gemini-local` — running the root suite silently undercounts those packages (matches council R1 finding #4). Per-package invocation worked because each has its own `vitest.config.ts`.
- Several adapter packages use different pnpm filter names than their directories (e.g., `@founderos/adapter-claude-local` vs `packages/adapters/claude-local`, and `@founderos/gemini-api` for `gemini-api`). Documented in the run commands appendix below.
- Coverage instrumentation overhead measured at ~10–25% wall-clock vs non-coverage. v8 lived up to its reputation; istanbul switch not justified by this audit's signal.

## 2. Summary table — per-package

| Package | Line% | Branch% | Func% | Files <50% line | Files >=95% line | Total measured files |
|---|---:|---:|---:|---:|---:|---:|
| **server** | 55.00 | 67.47 | 65.47 | 130 | 61 | 329 |
| **ui** | 21.75 | 66.16 | 42.01 | 289 | 59 | 430 |
| shared | 78.57 | 71.25 | 69.31 | 10 | 29 | 52 |
| db | 23.40 | 66.09 | 31.57 | 19 | 2 | 113 |
| runner | 74.35 | 66.97 | 88.88 | 0 | 2 | 10 |
| cli | 35.78 | 66.94 | 68.51 | 36 | 5 | 59 |
| mcp-server | 69.73 | 62.79 | 68.42 | 2 | 0 | 5 |
| templates | 99.66 | 100.00 | 66.66 | 0 | 3 | 4 |
| adapter-anthropic-api | 61.50 | 77.38 | 83.33 | 2 | 0 | 3 |
| adapter-openai-api | 54.79 | 72.85 | 72.72 | 2 | 0 | 3 |
| adapter-gemini-api | 59.60 | 65.62 | 80.00 | 1 | 1 | 3 |
| adapter-claude-local | 28.57 | 36.52 | 59.09 | 9 | 2 | 14 |
| adapter-codex-local | 19.10 | 41.57 | 54.23 | 10 | 1 | 13 |
| adapter-opencode-local | 15.32 | 55.22 | 62.85 | 8 | 0 | 11 |
| adapter-pi-local | 16.41 | 71.59 | 56.66 | 7 | 0 | 9 |

**Observations**:
- `templates` already meets the goal (99.66% / 100%). Move it to "done" in G1.
- `runner` is the model of where the rest should go: 74%/67% on real spawn + real http E2E. Re-use the pattern (see `packages/runner/src/__tests__/spawn-e2e.test.ts`) for the CLI-family adapters.
- `db` 23% is misleading — 11 large seed files (~8.6K lines combined) dominate the denominator. Excluding seeds, `db/src/` is closer to ~80%. Listed as an exemption below.
- `cli` 35% is real gap: 36 of 59 files at <50% (most commands have zero tests).
- The four CLI-family adapter packages (claude-local, codex-local, opencode-local, pi-local) cluster at 15–29% — the lowest band — because they have helper coverage but no E2E layer like runner. They are the highest-leverage adapter targets after the API-family.

## 3. Bottom 30 files (cross-package, by uncovered-line count)

Sorted by absolute uncovered lines (line total × (1 – line%)) so the file ranking surfaces the highest leverage targets, not just the smallest 0% files.

| # | File | Line% | Branch% | Uncovered lines | Reason for gap | Recommended action |
|---|---|---:|---:|---:|---|---|
| 1 | `ui/src/pages/IssueDetail.tsx` | 0.0 | 0.0 | 1995 | Page-level shell — no sibling test; inbox/issue is critical-path. | **P0**: split into pure helpers + container; component tests on helpers, Playwright on container. |
| 2 | `ui/src/pages/Inbox.tsx` | 7.8 | 25.0 | 1839 | Already has `Inbox.test.tsx` but very narrow surface. | **P0**: extend existing test to cover row interactions, filter chips, badge state. |
| 3 | `packages/db/src/seed-mira-labs-month1-inbox.ts` | 0.0 | 100.0 | 1710 | Demo seed, non-shipping. | **Exempt** — add to `coverage.exclude`. |
| 4 | `cli/src/commands/worktree.ts` | 24.1 | 56.4 | 1537 | Large command, partial unit tests on internal helpers. | **P1**: subprocess E2E using `node:child_process` against the real CLI (per goal G7). |
| 5 | `ui/src/pages/AgentDetail.tsx` | 3.5 | 100.0 | 1495 | Critical-path agent page; only branch-touch coverage. | **P0**: agent-detail unit tests on the AgentTabs/LogViewer split. |
| 6 | `server/src/routes/access.ts` | 41.5 | 52.8 | 1447 | Permission/access enforcement — security hot path. | **P0**: route-handler tests per auth role × action × tenant matrix. |
| 7 | `server/src/services/company-skills.ts` | 34.7 | 62.6 | 1352 | Skills loading/validation; partial coverage. | **P1**: service tests on skill registration + lookup error paths. |
| 8 | `packages/db/src/seed-mira-labs-month1-finance.ts` | 0.0 | 100.0 | 1325 | Demo seed. | **Exempt**. |
| 9 | `packages/db/src/seed-demo-narrative.ts` | 0.0 | 100.0 | 1313 | Demo seed. | **Exempt**. |
| 10 | `server/src/services/heartbeat.ts` | 60.8 | 54.3 | 1310 | Wakeup orchestration — runner-touching critical path. | **P0**: integration tests for each wakeup source (assignment, approval, comment, plugin-internal). |
| 11 | `packages/db/src/seed-mira-labs-month1-issues.ts` | 0.0 | 100.0 | 1302 | Demo seed. | **Exempt**. |
| 12 | `ui/src/components/IssueChatThread.tsx` | 27.6 | 64.4 | 1167 | Issue chat — visual + behavior; partial coverage. | **P1**: extend existing IssueChatThread tests with reply/scroll/typing-indicator. |
| 13 | `packages/db/src/seed-mira-labs-month1-runs.ts` | 0.0 | 100.0 | 1154 | Demo seed. | **Exempt**. |
| 14 | `server/src/routes/plugins.ts` | 3.9 | 100.0 | 1150 | Plugin route handlers — almost untested. | **P1**: route tests on install/activate/uninstall lifecycle (matches G9). |
| 15 | `ui/src/components/OnboardingWizard.tsx` | 0.0 | 0.0 | 1127 | LEGACY wizard — replaced by `FounderOnboardingWizard` under V2 flag. | **Exempt** (legacy fallback; cover via Playwright if `VITE_FOUNDEROS_ONBOARDING_V2=false` is supported). |
| 16 | `ui/src/components/AgentConfigForm.tsx` | 5.8 | 100.0 | 1110 | Large agent config form. | **P1**: form-validation tests; reuse RTL fixture pattern from `AdapterValidationPanel.test.tsx`. |
| 17 | `server/src/routes/agents.ts` | 50.6 | 62.1 | 1105 | Agent CRUD + lifecycle endpoints; partial. | **P0**: gap-fill route tests per endpoint (matches G3). |
| 18 | `ui/src/pages/CompanyImport.tsx` | 0.0 | 0.0 | 1072 | Multi-step import flow; no test. | **P2**: split helpers + RTL render of step shells. |
| 19 | `ui/src/pages/CompanySkills.tsx` | 0.0 | 0.0 | 1069 | Page-level shell. | **P2**: helper-extract + RTL render. |
| 20 | `packages/db/src/seed-mira-labs-month1-knowledge.ts` | 0.0 | 100.0 | 1022 | Demo seed. | **Exempt**. |
| 21 | `ui/src/pages/DesignGuide.tsx` | 0.0 | 0.0 | 1018 | Internal `/design-guide` showcase. | **Exempt** — internal tooling, not a buyer-demo surface. |
| 22 | `ui/src/pages/agent-detail/AgentTabs.tsx` | 2.8 | 100.0 | 1005 | Critical-path agent tabs. | **P0**: tab-switch + content render tests. |
| 23 | `ui/src/components/ProjectProperties.tsx` | 0.0 | 0.0 | 978 | Project-side panel. | **P2**: prop-by-prop render assertions. |
| 24 | `ui/src/pages/RoutineDetail.tsx` | 0.0 | 0.0 | 972 | Routines page. | **P2** if routines is in demo journey; else **P3**. |
| 25 | `ui/src/pages/Costs.tsx` | 0.0 | 0.0 | 966 | Costs dashboard. | **P2**. |
| 26 | `ui/src/pages/Landing.tsx` | 0.0 | 0.0 | 947 | Landing page — covered by Playwright `critical-flows.spec.ts` already. | **Exempt** from unit coverage; assert flow via existing Playwright. |
| 27 | `server/src/services/plugin-loader.ts` | 2.4 | 100.0 | 916 | Plugin loader — security-relevant. | **P1**: lifecycle tests on load/validate/install. |
| 28 | `ui/src/pages/CompanySettings.tsx` | 0.0 | 0.0 | 888 | Settings page. | **P2**: settings-tab render tests. |
| 29 | `ui/src/pages/departments/FinanceConsole.tsx` | 0.0 | 0.0 | 857 | Finance department console. | **P2** if Finance is in demo journey; else **P3**. |
| 30 | `ui/src/pages/departments/CrmConsole.tsx` | 0.0 | 0.0 | 849 | CRM department console. | **P2**. |

**Pattern observed**: 17 of 30 are `ui/` page-level shells at 0%. These are the canonical case where council §1's "UI 80/70 floor" applies — pushing them to 99% via component tests produces low-assertion-value snapshot tests. The honest fix is Playwright flow coverage + a lower threshold on `ui/src/pages/*.tsx`.

## 4. Critical-path coverage (7 buyer-demo journeys)

| Journey | Unit / RTL coverage | Integration coverage | E2E (Playwright) | Verdict |
|---|---|---|---|---|
| **Signup / auth** | `pages/Auth.tsx` 0% — no `Auth.test.tsx`. `App.tsx` 0% — no `App.test.tsx`. | `server/src/__tests__/auth-*.test.ts` covers JWT path + `supabase-auth-hook.test.ts`. | `tests/e2e/onboarding.spec.ts` + `e2e/tests/auth-round-trip.spec.ts` exist. | **YELLOW** — server is covered, UI shell is not. **P0 gap**: write `pages/Auth.test.tsx`. |
| **Onboarding** | V2 wizard at 17.6%; legacy `OnboardingWizard.tsx` at 0% (legacy, exempt); `OnboardingWizardNew.tsx` 0% (third variant). | `__tests__/onboarding-bootstrap-atomicity.test.ts`, `onboarding-draft.test.ts`, `onboarding-adapter-type.test.ts`. | `e2e/tests/critical-flows.spec.ts` + `tests/e2e/onboarding.spec.ts`. | **YELLOW** — primary V2 wizard needs RTL coverage of step flow + draft-hydration gap (per CLAUDE.md known UX gap #1). |
| **Agents / wakeup** | `pages/Agents.tsx` 0%; `pages/AgentDetail.tsx` 3.5%; `AgentConfigForm.tsx` 5.8%. | `__tests__/agents-lifecycle-audit.test.ts`, `agent-live-run-routes.test.ts`, plenty of agent-* tests. | Covered indirectly via critical-flows.spec.ts. | **RED on UI** — server has 20+ agent tests; UI page shells are completely untested. **P0**. |
| **Inbox / issues** | `pages/Inbox.tsx` 7.8%; `pages/IssueDetail.tsx` 0%; `IssueChatThread.tsx` 27.6%. | `__tests__/issues-*.test.ts` (15+ files), `inbox-state.test.ts`. | `tests/e2e/onboarding.spec.ts` covers some inbox flow. | **YELLOW on UI** — server is dense; UI is missing detail page coverage. |
| **Goals** | `pages/Goals.tsx` 18.7%; `pages/GoalDetail.tsx` has a test. | No `server/src/services/goals.test.ts` exists; only fallback/context tests. **Gap**. | Not present in `e2e/tests/`. | **RED** — no goals service test, no goals Playwright flow. **P0**. |
| **Integrations** | `pages/Integrations.tsx` 73.4%; `pages/AiConnections.tsx` 95.1% (good). | `__tests__/integrations-service.test.ts`, `integration-health.test.ts`, `integration-dlq.test.ts`. | Implicit in onboarding flows. | **GREEN** — best-covered journey. Marginal gap on `pages/Integrations.tsx` last 27%. |
| **Billing** | `components/BillingGate.tsx` 0% — no test. | `__tests__/billing-gate.test.ts`, `billing-routes.test.ts`. | `e2e/tests/client-readiness/billing-gate-blocks-on-cancellation.spec.ts`. | **YELLOW** — server + Playwright are covered; UI gate component has no unit test. **P1**. |

**Summary**: 3 RED (signup/agents UI; goals end-to-end), 3 YELLOW (onboarding wizard, inbox UI, billing UI), 1 GREEN (integrations). The goals journey is the most exposed — neither a goals-service unit test nor a Playwright spec exists.

## 5. Exemptions (recommended)

These should be added to `coverage.exclude` per-package and listed in `docs/runbooks/test-coverage-policy.md` (the policy doc per G2). Each row tightens what council §2 flagged.

| Path / glob | Reason | c8/v8 ignore shape |
|---|---|---|
| `packages/db/src/seed-*.ts` (11 files) | Demo / synthetic seeds — not shipping code paths. ~8.6K lines combined dominate `db/` denominator. | `coverage.exclude: ['src/seed-*.ts']` in `packages/db/vitest.config.ts` |
| `server/scripts/seed-mira-labs.local.ts` | Local-only seed script. | `coverage.exclude: ['scripts/seed-*.ts']` |
| `packages/plugins/examples/**/*` | Buyer-facing demonstration code (per goal G1 line 22). **BUT** keep `plugin-hello-world-example` in denominator at 60% if it is the test fixture for G9 SDK lifecycle (council §2.4 loophole). | `coverage.exclude: ['examples/**']` with a per-package override |
| `packages/plugins/create-founderos-plugin/templates/**` | Templates copied verbatim into new projects; the **scaffold runner** itself must remain in the denominator. | `coverage.exclude: ['templates/**']` (not the whole package) |
| `ui/src/components/ui/**` (22 files) | Shadcn-generated primitives. Library code, not application logic. | `coverage.exclude: ['src/components/ui/**']` |
| `ui/src/pages/DesignGuide.tsx` | Internal showcase, not a buyer surface. | `/* c8 ignore file */` header |
| `ui/src/pages/Landing.tsx` | Covered by Playwright `critical-flows.spec.ts`; unit test would duplicate. | `/* c8 ignore file */` header — but pair with the assertion that the Playwright test stays green. |
| `ui/src/components/OnboardingWizard.tsx`, `ui/src/components/OnboardingWizardNew.tsx` | Legacy + variant wizards; V2 (`FounderOnboardingWizard`) is canonical. | `/* c8 ignore file */` headers; track for removal if V2 sticks. |
| `**/*.d.ts`, `dist/`, `coverage/`, `.claude/worktrees/`, `test-results/` | Build artifacts. | Already excluded by v8 default; confirm in policy. |
| `packages/shared/src/telemetry/client.ts`, `telemetry/events.ts` | Telemetry transport — fire-and-forget side effects. Mock at consumer site. | `coverage.exclude: ['src/telemetry/**']` IF consumer-side mocks remain. |
| `packages/db/src/migration-runtime.ts`, `packages/db/migrations/**` | Generated SQL + migration journal. | Already excluded; explicit confirm. |
| Vite/eslint/tailwind/postcss configs | Hand-written but typically untestable. Council §2.2 says keep in denominator UNLESS justified. | Per-file `/* c8 ignore file */` with one-line rationale comment. |

**Important**: Do NOT exempt server/src/auth/better-auth.ts (0%) or `server/src/auth/clerk.ts` — these are real auth integrations that need tests (or deletion if unused; verify before exempting).

## 6. Prioritized fix list — top 10 files to test first, ordered by demo impact

| # | File | Pkg | Current line% | Why this first | Suggested test type |
|---|---|---|---:|---|---|
| 1 | `ui/src/pages/Auth.tsx` | ui | 0.0 | Buyer signup is journey #1; UI shell is the only step without unit coverage. | RTL render + form submit; mock `supabase.auth.signIn`. |
| 2 | `server/src/services/goals.ts` + `server/src/routes/goals.ts` | server | (not in cov above 30 floor) | RED on goals journey — no service test exists. Goals demo blocked without it. | Service unit + route integration (matches G3 pattern). |
| 3 | `ui/src/pages/Agents.tsx` | ui | 0.0 | Agents is journey #3; entire page is untested while server has 20+ agent tests. | RTL render with `MemoryRouter`; mock `agentsApi`. |
| 4 | `ui/src/pages/IssueDetail.tsx` | ui | 0.0 | Largest uncovered surface (1995 lines) on a critical buyer journey. | Split into helpers first; RTL on the container. |
| 5 | `server/src/routes/access.ts` | server | 41.5 | Security-critical permission enforcement; only 41% covered. | Route-handler tests on role × action × tenant matrix. |
| 6 | `server/src/services/heartbeat.ts` | server | 60.8 | Heartbeat is the wakeup spine; missing branch coverage on wakeup-source classification. | Integration tests per wakeup origin (assignment / approval / comment / plugin-internal). |
| 7 | `ui/src/components/BillingGate.tsx` | ui | 0.0 | Billing journey YELLOW — server has the gate test but UI component has zero. | RTL render with `billingState=expired` / `active` / `inactive` props. |
| 8 | `ui/src/pages/AgentDetail.tsx` + `ui/src/pages/agent-detail/AgentTabs.tsx` | ui | 3.5 / 2.8 | Agents journey extension; bundle these in one PR. | RTL tab-switch + content-render assertions. |
| 9 | `cli/src/commands/worktree.ts` + `cli/src/commands/env.ts` + `cli/src/commands/auth-bootstrap-ceo.ts` | cli | 24.1 / 0.0 / (check) | Admin-recovery escape hatch per CLAUDE.md — MUST have regression test. | Subprocess E2E via `child_process.spawn`. |
| 10 | `packages/adapters/claude-local/src/server/execute.ts` (cluster of 4 CLI-family) | adapters | 28.6 (claude), 19.1 (codex), 15.3 (opencode), 16.4 (pi) | The unit-vs-E2E gap that motivated G6. Each is small (10-15 source files) but at 15-29%. | Subprocess E2E mirroring `packages/runner/src/__tests__/spawn-e2e.test.ts`. |

## 7. Notes on what was NOT measured

- **Playwright E2E coverage** (under `e2e/tests/` and `tests/e2e/`) is not measured by vitest. The flow grid from goal G5 lives entirely there and should be tracked separately. Existing specs: 9 in `e2e/tests/`, 3 in `tests/e2e/`.
- **`packages/shared`** has 78.57% line / 71.25% branch. The biggest single gap is `validators/plugin.ts` at 36.4% (404 lines). Listed as a tier-2 priority after the top-10.
- **Known flakes** per `docs/CI-KNOWN-FLAKES.md` — `workspace-runtime.test.ts` is fixed; `backup-lib.test.ts` round-trip is quarantined (pre-existing `pg_dump` FK rendering bug, not a coverage gap).
- **Adapters with NO tested-package signal**: `packages/adapters/cursor-local`, `packages/adapters/openclaw-gateway`, `packages/adapters/gemini-local`, `packages/adapter-utils`, `packages/plugins/sdk` — these are listed in goal G1 baseline as "unmeasured" and need their own `vitest.config.ts` per council §4 G0.5 finding before re-running this audit.

## 8. Run commands reference

For reproducibility — these are the pnpm filter names that work today:

```bash
# Big ones
pnpm --filter @founderos/server   exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-server --max-workers=4
pnpm --filter @founderos/ui       exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-ui     --max-workers=2

# Medium
pnpm --filter @founderos/runner   exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-runner
pnpm --filter @founderos/shared   exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-shared
pnpm --filter @founderos/db       exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-db
pnpm --filter founderos           exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-cli   # cli package is named 'founderos'
pnpm --filter @founderos/templates exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-templates
pnpm --filter @founderos/mcp-server exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-mcp

# Adapter packages — note inconsistent naming
pnpm --filter @founderos/adapter-claude-local   exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-claude-local
pnpm --filter @founderos/adapter-anthropic-api  exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-anthropic-api
pnpm --filter @founderos/adapter-openai-api     exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-openai-api
pnpm --filter @founderos/adapter-codex-local    exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-codex-local
pnpm --filter @founderos/adapter-opencode-local exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-opencode-local
pnpm --filter @founderos/adapter-pi-local       exec vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-pi-local
# gemini-api uses bare-name scope (no 'adapter-' prefix):
(cd packages/adapters/gemini-api && npx vitest run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-gemini-api)
```

**Naming inconsistency to fix in a separate task**: standardize all adapter packages to `@founderos/adapter-<name>` so `pnpm --filter '@founderos/adapter-*'` works as one batch.

---

_End of audit. Next action: G1 closeout — feed top-10 fix list into G3/G4/G6/G7 work plan. Re-run this audit after each sprint to confirm the per-package line% deltas._
