# GOAL — Buyer Demo Readiness (DoubtBuddy MVP cutover validation)

**Status:** Active, started 2026-05-18 23:30 UTC · scope expanded 2026-05-19 (self-serve mandate)
**Owner:** Claude (autonomous execution authorized)
**Target:** Demo-ready production state matching ADR-012 contract; zero compromises on MVP scope. **Buyer must be able to self-serve end-to-end: create their own account, connect their own runner, and create their own company without operator intervention.**
**Buyer:** DoubtBuddy ($4k Paperclip whitelabel — see ADR-012, design-partner-onboarding-kit.md)

### Self-serve definition (added 2026-05-19)

The buyer-demo bar is **not** "we drive the demo for them" — it is "we send them `founderos.fly.dev`, they sign themselves up, connect their own runner, and produce their first agent run within 15 minutes with zero handholding from us." Every audit finding gets re-ranked by **self-serve break-glass impact**:

| Self-serve step | Surface | Break-glass risk |
|---|---|---|
| 1. Land on `founderos.fly.dev` | `Landing.tsx` | Dead footer anchors → credibility cliff (P0-E) |
| 2. Click "Build your company" | `/auth` | Clean — works |
| 3. Sign up via Google OAuth or email/password | Better-Auth + Supabase | Clean — works |
| 4. Receive welcome email | Resend transport | **RESEND_API_KEY unset → silent no-op** (Config P0 #2) — buyer thinks "is this real?" |
| 5. Open onboarding wizard | `FounderOnboardingWizard` | V2 wizard does NOT hydrate from `onboarding_drafts` on reload — if buyer's tab crashes, they restart from step 1 (P1, was acceptable; now elevated) |
| 6. Pick adapter (CLI family) | `AdapterValidationPanel` | Clean — walkthrough is the contract |
| 7. Launch → land on dashboard | `/onboarding/bootstrap` | Clean — works |
| 8. Install runner on laptop | `RunnerInstallDialog` deep-link | Clean — `?install-runner=1` query param auto-opens |
| 9. First agent run | `@founderos/runner` 0.1.1 | **SIGKILL escalation broken** when CLI traps SIGTERM — agent hangs for full natural runtime (G6 — fix verified in worktree, not yet integrated) |
| 10. Create first goal | `Goals.tsx` | **No "+ New Goal" button** — buyer dead-ends (P0-C) |
| 11. Create first project | `Projects.tsx` | **No "+ New Project" button** — buyer dead-ends (P0-D) |
| 12. Wire first integration (Slack/Gmail) | `Integrations.tsx` → Composio | Clean if Composio env configured (it is, per AUDIT-CONFIG) |
| 13. See first agent activity | `Today` + `Inbox` | Clean |

**Self-serve hard blockers (every P0 here MUST close before buyer hand-off):**
- Goals page missing "+ New Goal" button (UI P0-C)
- Projects page missing "+ New Project" button (UI P0-D)
- `RESEND_API_KEY` unset → welcome email silent no-op (Config P0 #2)
- Runner SIGKILL escalation broken (G6) — must publish 0.1.2 + bump dependency
- Landing footer 12 dead anchors (UI P0-E)

**Self-serve strong recommends (close pre-demo if time):**
- V2 wizard draft hydration (`FounderOnboardingWizard.tsx` known gap) — without it, a closed tab is unrecoverable
- Department consoles' mock data gating (P0-A) — buyer will explore non-default departments
- `EMAIL_UNSUBSCRIBE_SECRET` unset → first customer-email send throws

**Acceptable to defer (logged in ADR-012):**
- `/brief` magic-link token consume — authenticated `/brief` works
- Notification bell WS push — REST polling works
- Slack daily summary cron


## The contract (what was promised)

Per **`docs/adr/012-mvp-cutover-doubtbuddy.md`** + **`docs/ops/design-partner-onboarding-kit.md`**, the buyer was sold:

### Pricing tier ("FounderOS Beta", $500–$1,000/mo)
- 1 workspace
- 3 departments (CoS + Growth + Content as defaults; Finance is the fourth agent per ADR-012)
- 50,000 actions/mo
- 5 integrations
- Email + Slack support

### 6-sprint feature scope (S1–S6, all marked shipped 2026-05-06)
| Sprint | Promise | File anchor |
|---|---|---|
| S1 | Instance bootstrap, board API keys, RBAC, tenant isolation | `server/src/services/{instance,access,api-keys}.ts` |
| S2 | Composio v3, integration ingest, event-ingest singleton, dedup-key contract | `server/src/services/{composio,integration,event-ingest}.ts` |
| S3 | 4 default agents (CoS / growth / content / finance), heartbeats, daily brief, magic-activation gate | `server/src/services/{heartbeat,agent}.ts` + daily-brief routes |
| S4 | Content briefs + drafts + scheduling, churn-rescue (autonomous revenue-rescue loop) | `server/src/services/{content,churn-rescue}.ts` |
| S5 | Revenue cockpit, churn forecast, runway model, pricing simulator, LTV/CAC, experiment ROI rollup, cash planning, scenario chat (LLM tool-use), console consolidation | `ui/src/pages/Finance*.tsx` + finance services |
| S6 | Permissions matrix, workflow-aware approvals, audit lineage, agent memory, named workflow templates, notifications data layer, magic-link tokens, onboarding draft persistence | `server/src/services/{permissions,workflow,audit,memory,notifications,magic-link,onboarding-drafts}.ts` |

### Architecture promises
- Single-origin Fly deploy (`founderos.fly.dev`) — no cross-origin failure modes
- Better-Auth + Supabase auth + tenant isolation + composite-FK same-tenant invariants
- Per-instance Anthropic key support (G3b shipped 2026-05-18 — this PR #266)
- BYO runner pattern + Composio v3 cross-org isolation
- Stripe webhook + opt-in billing gate (`FOUNDEROS_BILLING_GATE_ENABLED`)

### Explicitly deferred to v1.1 (per ADR-012, NOT MVP)
1. UI bell + WS push (notifications data layer exists; UI consumer doesn't)
2. Slack daily summary cron
3. Email-template magic-link issuance
4. `/brief` route token consumption
5. Wizard rewiring to draft API (we already know V2 wizard doesn't hydrate from draft — CLAUDE.md flags this)
6. Embedder for memory cosine recall

**Implication:** these 6 wires are KNOWN MISSING. The buyer agreed in writing. Re-confirm in the readiness audit but do NOT panic-build them.

## Success criteria (acceptance gates)

This goal is **complete** when all of these are green:

| Gate | Target |
|---|---|
| **G1. Promised features ship** | Every S1-S6 promise per ADR-012 has working code + UI surface + happy-path test |
| **G2. Test coverage** | ≥99% line / ≥95% branch (vitest --coverage); 100% on critical-flow E2E (Playwright) |
| **G3. Buyer demo script works** | All 7 demo journeys (signup → onboarding → first run → inbox → goal → integration → billing) succeed live on `founderos.fly.dev` |
| **G4. Zero P0/P1 bugs open** | Investigate every "broken button / dead route / silent 500" and fix or quarantine with documented rationale |
| **G5. Canary 401 fixed in prod** | Post-deploy Fly logs show ZERO `actorType:"none"` 401s on signed-in session (this PR #266 closes this) |
| **G6. Runner SIGKILL fix shipped** | Runner `0.1.2` published to npm with the `!exited` flag fix + un-skipped test (h) green |
| **G7. Config audit clean** | All Fly secrets set, CSP allowlists current, JWT secret bootstrapped, Composio configs present for all 8 default toolkits, billing gate behavior verified |
| **G8. Buyer-facing docs current** | `docs/ops/design-partner-onboarding-kit.md` reflects shipped state; CONTINUE.md is the authoritative "what's next" surface; deferred-to-v1.1 list is accurate |

## Phases (executable, sequenced)

### Phase 0 — Land the in-flight ship (in progress)
- ✅ PR #266 committed (5 commits + 3 carry-over)
- ✅ Pushed
- ⏳ CI green + auto-merge (CodeQL re-running after `mkdtempSync` security fix)
- ⏳ `deploy-prod.yml` → Fly deploy → post-deploy auth canary clean

**Gate to next phase:** PR #266 merged + Fly deploy succeeded + auth canary green for 5 min straight.

### Phase 1 — Map the territory (parallel agents, read-only)
Spawn audit agents in parallel — all read-only, all reporting back with structured findings:

1. **Codebase traversal graph** (task #32) — produces `.planning/CODEBASE-GRAPH.md`: UI routes → API endpoints → services → repos → schema; component tree; hook dependencies. One navigable doc, ≤300 lines.
2. **UI audit** (task #33) — produces `.planning/AUDIT-UI.md`: every page in `App.tsx`; for each route: handler exists? all CTAs wired? all forms submit successfully? Tagged P0/P1/P2/clean.
3. **Server audit** (task #34) — produces `.planning/AUDIT-SERVER.md`: every Express route; each has Zod validation + auth gate + error handling + happy-path test? Tagged P0/P1/P2/clean.
4. **Coverage gap audit** (task #35) — produces `.planning/AUDIT-COVERAGE.md`: vitest --coverage output sorted worst→best; identify the bottom 20 files; classify as "critical / test-only / dead-code".
5. **Promised-feature fidelity** (task #39) — produces `.planning/AUDIT-PROMISES.md`: cross-reference each S1-S6 promise vs. shipped reality. Each row: { promise, shipped? Y/N, evidence path, gap-if-any }.
6. **Config + secrets** (task #37) — produces `.planning/AUDIT-CONFIG.md`: Fly secrets (`fly secrets list`), CSP allowlist current, JWT bootstrap working, Composio per-toolkit configs, Stripe state, Supabase keys.

**Gate to next phase:** all 6 audit docs produced. Synthesize findings into a single prioritized fix list.

### Phase 2 — Fix the gaps (sequenced; some parallel)
Working from Phase 1's fix list, executed by category:

- **A — P0 bugs (broken in prod):** fix immediately, ship as small PRs, each merged to main individually.
- **B — Missing tests (G2 coverage gap):** task #38 loop. Lowest-coverage critical file first; write Vitest unit + integration tests; iterate until ≥99% line / ≥95% branch.
- **C — UI dead-ends (broken buttons/routes):** task #33 follow-ups. Each tagged P1/P2 gets a fix or quarantine decision.
- **D — Server contract gaps (missing Zod / auth / billing gate):** task #34 follow-ups.
- **E — Deferred-to-v1.1 verification:** confirm each of the 6 v1.1 items per ADR-012 IS actually still v1.1 scope. No surprise upgrades to v1.0. Same for any "we said we'd do X" promise — match contract.
- **F — Runner SIGKILL fix + publish:** task #30 + #40. Background agent already producing the fix; integrate, council, ship, publish 0.1.2.

**Gate to next phase:** all P0/P1 items closed; coverage at target; runner 0.1.2 published; UI surface has zero broken handlers.

### Phase 3 — Demo dress rehearsal (Playwright E2E)
- Build 7 critical-flow Playwright scripts (one per demo journey). Run against `founderos.fly.dev` preview. Each must pass 3× consecutively with no flakes.
- Capture screencast / screenshots for each at 375px (mobile) + 1440px (desktop) — buyer demo can happen on either.
- Produce `.planning/DEMO-SCRIPT.md`: step-by-step walkthrough the buyer can execute themselves.

**Gate to next phase:** all 7 flows pass 3× consecutively; demo script signed off (self-review).

### Phase 4 — Ship to the buyer
- Final smoke on `founderos.fly.dev` (5-min observation window for auth canary, error rate, latency).
- Send the buyer: PR list, demo URL, demo script, kit (already exists), CONTINUE.md.
- Open a "Buyer Sign-Off" tracking issue with checklist of demo journeys.

**Gate to "done":** buyer has signed off OR provided specific feedback that becomes the next iteration's input.

## Agent dispatch plan

| Phase | Agent | Type | Mode | Output |
|---|---|---|---|---|
| 1.1 | codebase-graph | general-purpose | read-only | `.planning/CODEBASE-GRAPH.md` |
| 1.2 | ui-auditor | general-purpose | read-only | `.planning/AUDIT-UI.md` |
| 1.3 | server-auditor | general-purpose | read-only | `.planning/AUDIT-SERVER.md` |
| 1.4 | coverage-auditor | general-purpose | read-only + bash for vitest run | `.planning/AUDIT-COVERAGE.md` |
| 1.5 | promise-auditor | general-purpose | read-only | `.planning/AUDIT-PROMISES.md` |
| 1.6 | config-auditor | general-purpose | read-only + bash for `fly secrets list` | `.planning/AUDIT-CONFIG.md` |
| 2.B | test-writer | tdd-guide | worktree-isolated, code-writing | tests fill coverage gaps |
| 2.F | runner-sigkill | general-purpose | worktree-isolated (already running) | diff for SIGKILL fix |
| 3 | e2e-runner | qa-engineer | Playwright | 7 Playwright spec files |

Parallel safety: Phase 1 agents are all read-only — no file-write conflict. Phase 2 worktree-isolated agents create their own branches; integrate via cherry-pick after review.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Coverage target (99%) infeasible** | Medium | High | Council critique of GOAL-99-percent-e2e-coverage.md flagged this — exempt plugin examples + generated code + non-shipping demos. Allow `/* c8 ignore */` with documented justification. |
| **Buyer demo flows touch non-shipped wires** | Medium | High | Phase 1.5 audit catches this. The 6 v1.1 wires (UI bell + WS push, etc.) MUST be in the demo script as "v1.1 preview" or flat-out skipped. |
| **Audit agents flood working tree with .planning/ files** | Low | Low | Worktree isolation for any write; main checkout stays clean per CLAUDE.md guidance. |
| **Phase 2 fixes regress Phase 0 work** | Medium | Medium | Each fix lands as own PR with CI gate. No rebase-and-force-push. |
| **CodeQL or other CI gate becomes blocking pattern** | High | Low | We already learned (PR #266) that CodeQL is real; treat findings as substance, not noise. |
| **Buyer changes scope mid-flight** | Low | High | ADR-012 is the contract. Anything outside that scope is v1.1. |

## Open questions for the buyer (ask before demo)
1. Demo environment: founderos.fly.dev or a separately-branded whitelabel host?
2. Stripe live key flip: pre-demo (real money flows) or post-demo (test-mode safe)?
3. Composio integrations to demo: all 8 (slack, gmail, github, googlecalendar, googlesheets, googledrive, notion, linkedin) or a subset?
4. Acceptable demo length: 30 min, 60 min, async-screencast?

## Status updates

Updates appended as phases complete. See `.planning/AUDIT-*.md` for per-phase deliverables and CONTINUE.md for current sprint state.
