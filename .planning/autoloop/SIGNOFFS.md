# Sign-offs — User Review Queue (v2 — post-council)

Items that need human decision. The chief-of-staff appends entries here when:

- Tier-2 PR opened (informational under "all permissions granted" posture; merge still gated)
- Tier-3 item reached (council-required, never auto-dispatched)
- Tier misclassification detected (diff-validator caught Tier-3 in declared Tier-1)
- CI failure on a previously-green PR after retry limit
- Cost telemetry crosses 80% of ceiling
- Mission drift detected
- Eng-queue empty AND backlog has only Tier-3 items (loop is parked)
- Scope expansion proposed
- Any other halt-class event

User reviews each entry, edits `status:`, and the next wake cycle acts.

**Status transitions**: `pending` → `approved` | `rejected` | `resolved` | `deferred`

---

## Summary Table (sorted by urgency — P0 → P1 → P2)

| ID | Priority | Type | Source | Blocking | Expires | Status | Recommended |
|---|---|---|---|---|---|---|---|
| SIG-001 | P0 | tier-3-council | BL-006 (B4 provider key schema) | unlocks BL-003/005/016/017 | 2026-05-18T00:00Z | pending | Schedule adversarial council; cite blast radius (packages/shared types + server routes + migrations) |
| SIG-002 | P0 | tier-3-council | BL-007 (P3.a Sidebar primary CTA) | unlocks BL-008/009/010/011 (P3 commander chain) | 2026-05-18T00:00Z | pending | One-way door — primary nav CTA. Council before merge; feature-flag any rollout |
| SIG-003 | P1 | tier-3-council | BL-019 (P6.a Composio catalog) | none directly (P6 isolated) | 2026-05-25T00:00Z | pending | `packages/shared/src/constants.ts` is cross-service contract — council before merge |
| SIG-004 | P1 | tier-3-council | BL-020 (P7 IA collapse) | depends on BL-007 + BL-016 | 2026-06-01T00:00Z | pending | Largest one-way door in plan. Council + feature flag VITE_FOUNDEROS_SIMPLIFIED_NAV |
| SIG-005 | P0 | tier-3-council | BL-001 actual bug (B2 bootstrap; CLAUDE.md note stale) | Anthropic/Gemini/OpenAI **API** runtime on Fly (currently collapse to claude_local) | 2026-05-18T00:00Z | pending | Coordinated 7-file Tier-3 dispatch spanning shared constants + new migration + new adapter package |

---

## Entry Schema (REVISED post-council P1-3)

```markdown
## [SIG-NNN] <topic>

- **type**: tier-2-review | tier-3-council | flake-escalation | spend-alert | mission-drift | tier-misclassification | scope-expansion | flake-unknown | port-collision | other
- **priority**: P0 (block activation) | P1 (block progress) | P2 (informational)
- **decision_required**: approve | reject | resolve | defer | escalate
- **blocking**: <what halts until resolved>
- **blast_radius**: <files affected, services, runtime impact, user-visible surfaces>
- **ci_state**: green | red | n/a
- **merge_state**: MERGEABLE | BLOCKED | BEHIND | n/a
- **source**: <BL-NNN, EQ-NNN, PR #N, or autoloop-cycle-N>
- **recommended_action**: <1 sentence>
- **expires_at**: <iso ts>
- **context**: 1-3 sentences
- **proposed**: what the autoloop wants to do
- **alternatives**: 1-2 other options
- **artifacts**: <PR #, commit, file paths>
- **status**: pending | approved | rejected | resolved | deferred
- **resolved_at**: null
- **resolution_note**: null
```

### Expiry semantics

If `expires_at` passes with `status: pending`:
- **P0** items: autoloop writes an additional SIGNOFFS entry escalating + halts the loop
- **P1** items: downgrade to `deferred` with note in council-log
- **P2** items: archive to `council-log.md` and remove from SIGNOFFS

---

## Entries

## [SIG-001] BL-006 B4 — provider key discriminated-union schema

- **type**: tier-3-council
- **priority**: P0
- **decision_required**: approve
- **blocking**: BL-003 (P2.b ProviderTile labels), BL-005 (P2.d tile descriptions), BL-016 (P5.a AI Connections page), BL-017 (P5.b company-level preferred provider) — all need per-provider key plumbing
- **blast_radius**: `packages/shared/src/types/**` (discriminated union types), `server/src/routes/onboarding.ts` (key validation), `server/src/services/onboarding-bootstrap.ts` (key consumption), `ui/src/components/onboarding/FounderOnboardingWizard.tsx` (key input UX per provider), possibly migrations on `instance_settings` or wherever keys persist. ~15 files. Cross-service contract — council-gated per locked plan.
- **ci_state**: n/a
- **merge_state**: n/a
- **source**: BL-006, autoloop-cycle-7
- **recommended_action**: Schedule adversarial council (Gemini + Codex) on the discriminated-union shape before any code edit. Cite locked plan's "one-way schema door" callout.
- **expires_at**: 2026-05-18T00:00Z
- **context**: BL-006 is the locked plan's explicit council-gate. Renaming `anthropicKey` → `{ provider, key }` is a one-way schema door that blocks 4 downstream backlog items. The autoloop cannot dispatch this because path rules force Tier-3 on `packages/shared/src/types/**`.
- **proposed**: Council reviews discriminated-union design, migration approach (in-place rename vs. parallel column + backfill), and rollout strategy. After approval, dispatch as a hand-coded Tier-3-approved PR.
- **alternatives**: (a) Defer entire B4 and patch the existing single-key flow with per-provider switch logic in `onboarding-bootstrap.ts` (worse — leaves the schema mismatch); (b) Cut B4 from scope and ship founder-language UI on top of the broken schema (worst — bakes in a bug).
- **artifacts**: `packages/shared/src/types/onboarding.ts`, `server/src/routes/onboarding.ts:291`, `server/src/services/onboarding-bootstrap.ts:201`, `ui/src/components/onboarding/FounderOnboardingWizard.tsx`
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null

## [SIG-002] BL-007 P3.a — Sidebar primary CTA "Ask FounderOS"

- **type**: tier-3-council
- **priority**: P0
- **decision_required**: approve
- **blocking**: BL-008 (CommanderBar), BL-009 (Ask router), BL-010 (Two-mode NewIssueDialog), BL-011 (Ask templates) — P3 commander UX entirely
- **blast_radius**: `ui/src/components/Sidebar.tsx:107`, `ui/src/components/MobileBottomNav.tsx:45`. Path rules force Tier-3 (primary nav structure). User-visible: every founder sees this on every page load.
- **ci_state**: n/a
- **merge_state**: n/a
- **source**: BL-007, autoloop-cycle-7
- **recommended_action**: Council before edit (locked plan flagged "Council at end of P0, P3, P7"). Feature-flag rollout: `VITE_FOUNDEROS_ASK_PRIMARY_CTA` defaulted off; flip on after qualitative testing.
- **expires_at**: 2026-05-18T00:00Z
- **context**: Replacing "New Issue" with "Ask FounderOS" is the keystone of P3's mental-model shift. One-way door: changes the primary founder action across the entire app. The locked plan explicitly requires council; path rules force Tier-3 on Sidebar.tsx + MobileBottomNav.tsx regardless of declared tier.
- **proposed**: Council reviews CTA copy + flag-gated rollout plan. After approval, dispatch as hand-coded Tier-3-approved PR with the flag default off.
- **alternatives**: (a) Add a secondary "Ask" CTA next to "New Issue" instead of replacing it (less disruptive but defeats the simplification); (b) Defer P3 entirely until P2 founder-language sweep proves out.
- **artifacts**: `ui/src/components/Sidebar.tsx:107`, `ui/src/components/MobileBottomNav.tsx:45`
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null

## [SIG-003] BL-019 P6.a — Composio catalog by business question

- **type**: tier-3-council
- **priority**: P1
- **decision_required**: approve
- **blocking**: none directly (P6 is isolated; integrations still work)
- **blast_radius**: `packages/shared/src/constants.ts:924` (catalog data — cross-service contract; path rule forces Tier-3), `ui/src/pages/Integrations.tsx:418` (rendering). 2 files but `constants.ts` is consumed by both server and UI.
- **ci_state**: n/a
- **merge_state**: n/a
- **source**: BL-019, autoloop-cycle-7
- **recommended_action**: Council reviews catalog re-grouping data shape. Confirms no breaking change to existing Composio toolkit IDs (which the server relies on for `connectedAccountId` resolution).
- **expires_at**: 2026-05-25T00:00Z
- **context**: Reorganizing the integration catalog by business outcome (Revenue / Growth / Sales / Comms / Knowledge) is founder-language UX, but it touches `packages/shared/src/constants.ts` which path rules force to Tier-3 because the catalog data is referenced from both server (toolkit IDs for Composio) and UI.
- **proposed**: Council confirms the data shape change is purely additive (new `category` field per toolkit, no rename of toolkit IDs). After approval, dispatch as Tier-3-approved PR.
- **alternatives**: (a) Move the category metadata to a UI-only mapping file in `ui/src/lib/`, leaving `constants.ts` untouched (Tier-2 dispatchable); (b) Defer P6 until B4 (BL-006) closes since both touch shared types.
- **artifacts**: `packages/shared/src/constants.ts:924`, `ui/src/pages/Integrations.tsx:418`
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null

## [SIG-004] BL-020 P7 — IA collapse (6-bucket nav)

- **type**: tier-3-council
- **priority**: P1
- **decision_required**: approve
- **blocking**: depends on BL-007 (SIG-002) + BL-016 landing first (Ask CTA must exist before nav-bucket "Ask"; AI Connections page must exist before "Setup" bucket)
- **blast_radius**: `ui/src/components/Sidebar.tsx`, `ui/src/components/MobileBottomNav.tsx`, `ui/src/App.tsx`, `ui/src/lib/company-routes.ts`, `ui/src/pages/**` (route rewiring across ~25 pages → 6 buckets), `vite.config.ts` if flag plumbing changes, possible localStorage migration for saved view state. 10+ files. Largest one-way door in the plan.
- **ci_state**: n/a
- **merge_state**: n/a
- **source**: BL-020, autoloop-cycle-7
- **recommended_action**: Council + feature flag `VITE_FOUNDEROS_SIMPLIFIED_NAV`. Default off until ≥3 qualitative founder tests confirm the 6-bucket mental model lands. Defer until BL-007 and BL-016 are merged.
- **expires_at**: 2026-06-01T00:00Z
- **context**: Collapsing ~25 nav items into 6 buckets (Home / Ask / Decisions / Work / Setup / Advanced) is the most user-visible structural change of the rework. Locked plan explicitly council-required. Cannot dispatch even if approved — depends on prerequisite work landing first.
- **proposed**: Open council session covering: bucket taxonomy validity, migration path for existing route memory (deep links, bookmarks), feature-flag rollout plan, rollback strategy.
- **alternatives**: (a) Ship an "Advanced view" toggle that shows the current ~25 items, defaulting new founders to 6 buckets (preserves engineer-mode parity); (b) Defer P7 entirely to v1.1 — ship through P2-P6 and revisit IA after measurable adoption data.
- **artifacts**: Sidebar.tsx, MobileBottomNav.tsx, App.tsx, company-routes.ts, ~12 page routes
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null

## [SIG-005] BL-001 B2 — server bootstrap honors chosen adapter (Tier-3 escalation from EQ-001)

- **type**: tier-3-council
- **priority**: P0
- **decision_required**: approve
- **blocking**: Anthropic / Gemini / OpenAI **API** runtime on Fly. Currently every API-tier choice silently collapses to `claude_local` (spawning the Claude CLI that does not exist in the Fly container). Founder pays for Anthropic API key, picks Anthropic tile, gets no agent execution.
- **blast_radius**: 7 files spanning 3 Tier-3 forbidden surfaces — `packages/shared/src/constants.ts` (cross-service contract), new `packages/db/src/migrations/0107_*.sql` (schema), new `packages/adapters/anthropic-api/` package (parallel of #165's gemini-api). Plus `server/src/adapters/{registry.ts, builtin-adapter-types.ts}` wiring, `server/src/routes/onboarding.ts` key-persistence widening, `server/src/services/onboarding-bootstrap.ts` resolver routing, `server/src/__tests__/onboarding-adapter-type.test.ts` assertion flip.
- **ci_state**: n/a
- **merge_state**: n/a
- **source**: BL-001, EQ-001 (abandoned), autoloop-cycle-7 dispatch return
- **recommended_action**: Schedule adversarial council on the coordinated dispatch shape. Once approved, dispatch a fresh Tier-3-approved PR sized for the surface. Until then, the autoloop's path validator (correctly) refuses to ship.
- **expires_at**: 2026-05-18T00:00Z
- **context**: The CLAUDE.md note about `server/src/services/onboarding-bootstrap.ts:201` hardcoding `claude_local` is **stale** — PR #148 already restructured the bootstrap into tri-branch resolution (hosted → BYO runner → dev/local). Line 201 today is `const secrets = secretService(txDb);`. EQ-001's agent caught this honestly and refused to commit a workaround. The actual remaining bug is upstream: `mapOnboardingChoiceToAdapter("anthropic_api")` returns `"claude_local"` when `FOUNDEROS_HOSTED_AGENTS_ENABLED=0` (your current Fly prod setting) AND `FOUNDEROS_BYO_RUNNER_ENABLED` is off. Parallel issue: `mapOnboardingChoiceToAdapter("google_api")` throws despite #165 shipping `@founderos/gemini-api`, and `openai_api` (from #164) is similarly unwired.
- **proposed**: Single coordinated Tier-3 PR with the 7-file surface. Council reviews migration safety (single-statement ALTER per vinamr-invariants Postgres lock guidance), the new adapter package shape, and the test-assertion flip strategy. After approval, dispatch as hand-coded Tier-3-approved PR.
- **alternatives**:
  - **(a) Smallest slice — route `google_api → gemini_local`** so the in-tree gemini-local multi-mode adapter handles API via `GEMINI_API_KEY` env detection. Still incomplete: `server/src/routes/onboarding.ts` only persists `instance_api_keys` for `anthropic_api`; Google key would be dropped on the floor.
  - **(b) Pre-step — flip `FOUNDEROS_HOSTED_AGENTS_ENABLED=1` in Fly secrets.** Then `anthropic_api` resolves via the hosted-API branch instead of `claude_local` (no schema work). Risk: hosted-agents code path may not be production-tested at scale; check `packages/adapters/claude-local/src/server/execute.ts:51-52, 135-142, 394-432` (the hosted branch) and Sentry for prior errors.
  - **(c) Defer B2 entirely.** Ship P2-P4 founder-language UX on top of the broken adapter routing and revisit B2 once design partner feedback confirms the API-tier UX is reachable. (Worst — bakes in a bug; not recommended.)
- **artifacts**:
  - `packages/shared/src/constants.ts:58-186` (AGENT_ADAPTER_TYPES + ONBOARDING_ADAPTER_CHOICES — needs `anthropic_api`, `gemini_api` added)
  - `packages/db/src/migrations/0105_runner_jobs_adapter_type.sql:30-42` (CHECK constraint to extend)
  - `server/src/services/adapter-resolver.ts:309-312` (the `mapOnboardingChoiceToAdapter` switch that throws on `google_api` and collapses `anthropic_api`)
  - `server/src/adapters/registry.ts` + `builtin-adapter-types.ts` (registry plumbing for openai-api/gemini-api/anthropic-api)
  - `server/src/routes/onboarding.ts:270-380` (the `auth_mode === "api"` gate — widen key persistence beyond anthropic)
  - `server/src/services/onboarding-bootstrap.ts:339-356` (where the resolved adapter materializes)
  - `server/src/__tests__/onboarding-adapter-type.test.ts:257-260, 683-685` (locked-in assertions to flip)
  - `packages/adapters/gemini-api/src/index.ts` (reference shape for new `anthropic-api` adapter package)
  - `CLAUDE.md` (the "Onboarding adapter mismatch" note — needs deletion/correction post-fix)
- **status**: pending
- **resolved_at**: null
- **resolution_note**: null
