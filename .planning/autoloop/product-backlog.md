# Product Backlog (v2 — post-council)

Items the product team has identified for engineering. The chief-of-staff drains queued Tier-1 items into `eng-queue.md`. Tier-2 items open a SIGNOFFS entry for human review before dispatch. Tier-3 items NEVER dispatch automatically — always SIGNOFFS as `tier-3-council`.

**Tier declared by product is a HINT.** The actual tier is computed from the diff at dispatch + auto-merge time via path-based rules (see PROTOCOL.md "Tier Routing"). Auto-merge is gated on `actual_tier == tier_declared == 1`.

**Schema per entry** (REVISED post-council — `parent_plan_id`, `why_now`, `done_criteria` required):

```
## [BL-NNN] <title>
- parent_plan_id: <B1|B2|B3|B4|P1|P2|P3|P4|P5|P6|P7|P8|scope-expansion-<topic>>  # MANDATORY
- phase: <B2|B4|P2|P3|P4|P5|P6|P7|P8|other>
- tier_declared: <1|2|3>       # product's HINT; diff-validator computes actual tier
- complexity: <S|M|L>          # (S=1-3 files, M=4-10, L=10+)
- files_estimate: <count>
- dependencies: <[BL-N, BL-M] | none>
- council_required: <true|false>
- status: <queued|dispatched|merged|blocked|cancelled>
- created: <iso ts>
- summary: <1-2 sentence why>
- why_now: <1 sentence justifying this is in scope of the active phase>
- done_criteria:
  - <user-visible bullet>
  - <user-visible bullet>
```

**Items lacking `parent_plan_id` are rejected at intake** — see PROTOCOL.md "Parent Plan Binding" section. 2+ such items in a single product-dispatch triggers `mission-drift` halt.

---

## [BL-001] B2 — server bootstrap honors chosen adapter

- **parent_plan_id**: B2
- **phase**: B2
- **tier_declared**: 2
- **complexity**: S
- **files_estimate**: 3
- **dependencies**: none (independent of cascade — can dispatch first)
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/services/onboarding-bootstrap.ts:201` hardcodes `claude_local` regardless of the founder's chooser selection. Read the chosen adapter from the draft state and route correctly. Documented in FounderOS CLAUDE.md as "Onboarding adapter mismatch". Three audits flagged this in the locked plan.
- **why_now**: B1 cascade just landed mapping for all 6 tiles in the UI; without the server-side counterpart, founder selection still silently collapses to local CLI on Fly where it can't run.
- **done_criteria**:
  - Founder picks "Anthropic API" tile → onboarding-bootstrap creates anthropic_api adapter (not claude_local)
  - Server logs include the adapter family that was actually used (auditable)
  - Existing tests for `claude_local` + `skip` paths remain green

## [BL-002] P2.a — Step 4 onboarding copy: founder-language headline + subtitle

- **parent_plan_id**: P2
- **phase**: P2
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-006-blocked, P1-shipped]  <!-- DisplayDictionary lives on main once #169 lands -->
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Replace "Plug in your brain" Step 4 H1 with "How should FounderOS use AI?" + matching subtitle. Pure copy change. Uses DisplayDictionary keys from P1.
- **why_now**: P2 is the first founder-language sweep that follows P1's DisplayDictionary infrastructure landing.
- **done_criteria**:
  - Step 4 headline reads in founder language at viewMode=founder
  - viewMode=engineer preserves any technical strings
  - Snapshot test added asserting both modes

## [BL-003] P2.b — ProviderTile uses founder-language labels + brand logos

- **parent_plan_id**: P2
- **phase**: P2
- **tier_declared**: 1
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: ProviderTile + ProviderChooser swap engineer-language strings ("Anthropic API", "Codex CLI") for DisplayDictionary keys ("Claude (pay-per-use)", "ChatGPT (subscription)"). Add brand logos (Anthropic/OpenAI/Google) instead of text.
- **why_now**: Continues P2 founder-language sweep; tiles are the most visible non-technical surface in onboarding.
- **done_criteria**:
  - All 6 tiles show brand logo + founder-language label
  - viewMode=engineer falls back to the technical name
  - Existing provider-routing test (#167) still passes

## [BL-004] P2.c — Remove anthropic_api default in FounderOnboardingWizard

- **parent_plan_id**: P2
- **phase**: P2
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: none
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `FounderOnboardingWizard.tsx:82` initializes `adapterChoice: "anthropic_api"`. Change to `null` to force explicit founder choice (one of the 3 audit findings).
- **why_now**: Audit finding — the silent default biases analytics and fails non-Anthropic users.
- **done_criteria**:
  - Default state of adapterChoice is null
  - Continue button disabled until selection made
  - Test asserts no tile is pre-selected on first render

## [BL-005] P2.d — Tile descriptions in founder-language

- **parent_plan_id**: P2
- **phase**: P2
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-003]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Tile descriptions become "Claude (subscription) — uses your existing Claude Code app on your computer" style. Consume DisplayDictionary.
- **why_now**: Completes the P2 visible-copy sweep on the onboarding chooser.
- **done_criteria**:
  - All 6 tile descriptions reflect founder mental model (not API surface)
  - Descriptions stay under 100 chars to fit existing card layout

## [BL-006] B4 — provider key discriminated-union schema

- **parent_plan_id**: B4
- **phase**: B4
- **tier_declared**: 3
- **complexity**: L
- **files_estimate**: 15
- **dependencies**: none
- **council_required**: true
- **status**: queued (will not dispatch — surfaces as SIG-NNN tier-3-council)
- **created**: 2026-05-11T00:00:00Z
- **summary**: Rename `anthropicKey` → discriminated union `{ provider, key }`. Touches packages/shared types, server routes (`onboarding.ts:291`, bootstrap), FounderOnboardingWizard, possibly migrations. One-way schema door. Locked plan explicitly council-gated.
- **why_now**: B4 unblocks every per-provider key flow downstream; without it BL-003/BL-005/BL-016/BL-017 store the key in the wrong slot.
- **done_criteria**:
  - **NEVER auto-dispatched** — opens as `tier-3-council` SIGNOFFS, awaiting human + adversarial council verdict
  - When approved, scope explicitly bounded in council-log

## [BL-007] P3.a — Sidebar primary CTA: "Ask FounderOS"

- **parent_plan_id**: P3
- **phase**: P3
- **tier_declared**: 3  <!-- diff hits Sidebar.tsx → forced Tier-3 by path rule -->
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-002, BL-003]
- **council_required**: true
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Sidebar.tsx:107 + MobileBottomNav.tsx:45 replace "New Issue" / "Create" with "Ask FounderOS" / "Ask". Primary surface for founders. Council before merge (one-way door — changes the primary CTA and founder mental model).
- **why_now**: P3's Commander UX is the keystone of the rework; the sidebar CTA is the most visible entry point.
- **done_criteria**:
  - Council verdict logged before any code edit
  - SIDEBAR_CTA_LABEL flag-able for safe rollback

## [BL-008] P3.b — CommanderBar component (Cmd+K global Ask)

- **parent_plan_id**: P3
- **phase**: P3
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-007]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `CommanderBar.tsx` at top of app. Cmd+K opens "Ask the team to do something...". Replaces buried "New Issue" flow as primary entry point.
- **why_now**: P3 keystone — the global "Ask" affordance is what changes founder workflow from "fill a ticket" to "talk to the team".
- **done_criteria**:
  - Cmd+K opens overlay from any route
  - Submission routes to ask-router (BL-009)
  - Escape closes; focus returns to triggering element

## [BL-009] P3.c — Ask router service (Haiku-tier LLM)

- **parent_plan_id**: P3
- **phase**: P3
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 3
- **dependencies**: [BL-008]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/services/ask-router.ts` parses founder request → routes to correct department/agent. Haiku-tier (~$0.0001/route, ~500ms). Per-tenant rate-limit.
- **why_now**: CommanderBar (BL-008) needs a backend or it's UI without payload.
- **done_criteria**:
  - Single Haiku call returns `{ department, agent, urgency }`
  - p95 latency < 800 ms
  - Per-tenant rate limit enforced; logs include requestId

## [BL-010] P3.d — Two-mode NewIssueDialog (Founder default, Advanced disclosure)

- **parent_plan_id**: P3
- **phase**: P3
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 1 (large file)
- **dependencies**: [BL-009]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: NewIssueDialog.tsx (lines 1064, 1351, 1424 per plan) becomes business-ask + outcome + urgency + approval-pref by default. Advanced mode (assignee, project, model, workspace, thinking effort, reviewer) behind disclosure.
- **why_now**: P3 commander UX surfaces founder fields by default; advanced/engineer mode is the escape hatch.
- **done_criteria**:
  - Default form shows ≤ 4 fields
  - "Advanced" disclosure exposes the remaining fields exactly once
  - All existing engineer-mode E2E tests continue to pass

## [BL-011] P3.e — Ask templates empty-state

- **parent_plan_id**: P3
- **phase**: P3
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-010]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New AskTemplates.tsx — "Find why signups dropped", "Prepare investor update", "Draft LinkedIn posts", "Analyze churn", "Follow up with leads". Founder-language template list.
- **why_now**: Onboards founders into "what can I ask?" — combats blank-canvas paralysis at first Cmd+K open.
- **done_criteria**:
  - Empty state lists 5 templates
  - Clicking a template pre-fills CommanderBar

## [BL-012] P4.a — viewMode state + localStorage persistence

- **parent_plan_id**: P4
- **phase**: P4
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Add `viewMode: 'founder' | 'engineer'` to RunTranscriptView. Persisted in `localStorage["founderos.viewMode"]`. Settings → Advanced toggle.
- **why_now**: P4 transcript simplification needs a per-user switch; founder mode is opt-out for engineers.
- **done_criteria**:
  - Toggle persists across reloads
  - Default is "founder" for new users
  - Existing useDisplay hook (BL-006 follow-up) reads from the same key

## [BL-013] P4.b — Founder transcript hides thinking/tool blocks

- **parent_plan_id**: P4
- **phase**: P4
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-012]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: RunTranscriptView.tsx (lines 670, 692) hides TranscriptThinkingBlock, raw tool blocks, stderr_group (unless failed), init event (model/session). Engineer mode restores everything.
- **why_now**: P4 keystone — founders shouldn't see chain-of-thought; engineers must.
- **done_criteria**:
  - Founder mode shows only outcome cards + tool summaries
  - Engineer mode preserves current transcript exactly
  - Snapshot tests for both modes

## [BL-014] P4.c — Tool action summarization helper

- **parent_plan_id**: P4
- **phase**: P4
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-013]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `summarizeTool()` helper — turns "Executing tool bash_run_command with input ls -la" into "📂 Browsing files…". Founder-friendly action text.
- **why_now**: P4.b hides raw tool blocks; founders still need to know what happened.
- **done_criteria**:
  - Helper covers top-15 tool slugs with founder-language strings
  - Unknown tool slug falls back to "Working…"

## [BL-015] P4.d — Run outcome summary card (Haiku-cached)

- **parent_plan_id**: P4
- **phase**: P4
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-013]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `server/src/services/run-outcome-summary.ts` (Haiku, ~$0.0001/run). 1-line outcome + 3-bullet "what they did" generated from result event. Cached per-run. Top of every transcript.
- **why_now**: Closes P4 — founders open a transcript and read one card, not 80 messages.
- **done_criteria**:
  - Summary generated on result-event arrival, cached per-run
  - Reads from cache on subsequent transcript opens
  - Card visible at top of RunTranscriptView in both viewModes

## [BL-016] P5.a — AI Connections page scaffold

- **parent_plan_id**: P5
- **phase**: P5
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `ui/src/pages/AiConnections.tsx` — top-level nav item under Setup. Surfaces: Connected (chips with brand logos + status), Default for new work, Currently used by (per-department), Fallback order (drag-reorder).
- **why_now**: P5 — once tiles are founder-language (P2), founders need a place to manage providers post-onboarding.
- **done_criteria**:
  - Route /setup/ai-connections renders
  - Connected adapters list with brand logos
  - "Set default" + "Reorder fallbacks" both functional

## [BL-017] P5.b — Company-level preferred provider setting

- **parent_plan_id**: P5
- **phase**: P5
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 3
- **dependencies**: [BL-016]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/routes/companies.ts` + CompanySettings.tsx. NewAgent form respects company-level default. AgentConfigForm cross-warning when agent uses different provider than connected.
- **why_now**: P5 — per-company preference avoids "every new agent defaults to Anthropic" surprise.
- **done_criteria**:
  - Company.preferredProvider field persists
  - NewAgent inherits unless overridden
  - Warning shown when agent uses non-connected provider

## [BL-018] P5.c — Intelligence Health status dots

- **parent_plan_id**: P5
- **phase**: P5
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-016]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `IntelligenceHealth.tsx` on dashboard — Claude ✅, OpenAI ✅, Gemini ❌. Reads connected adapters + last-call success.
- **why_now**: P5 surface — founders see at-a-glance whether their AI is healthy without leaving the dashboard.
- **done_criteria**:
  - Dot per connected adapter
  - Click navigates to /setup/ai-connections (BL-016)

## [BL-019] P6.a — Composio catalog by business question

- **parent_plan_id**: P6
- **phase**: P6
- **tier_declared**: 3  <!-- packages/shared/src/constants.ts is Tier-3 by path rule -->
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-002]
- **council_required**: true
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `packages/shared/src/constants.ts:924` + `Integrations.tsx:418`. Reorganize integration catalog: Revenue (Stripe), Growth (PostHog/LinkedIn), Sales (HubSpot), Team comms (Slack), Knowledge (Notion). Cards show outcome ("Lets FounderOS explain churn").
- **why_now**: P6 founder-language pass on integrations — but `constants.ts` is cross-service contract → Tier-3 by path rule.
- **done_criteria**:
  - Council reviews scope and cross-service impact before any edit
  - Catalog grouping is purely visual — no API contract change

## [BL-020] P7 — IA collapse (6-bucket nav)

- **parent_plan_id**: P7
- **phase**: P7
- **tier_declared**: 3
- **complexity**: L
- **files_estimate**: 10
- **dependencies**: [BL-007, BL-016]
- **council_required**: true
- **status**: queued (will not dispatch — SIGNOFFS tier-3-council)
- **created**: 2026-05-11T00:00:00Z
- **summary**: Collapse ~25 nav items into 6 buckets (Home / Ask / Decisions / Work / Setup / Advanced). Feature-flagged `VITE_FOUNDEROS_SIMPLIFIED_NAV`. Primary nav structure = one-way door. Locked plan explicitly council-required.
- **why_now**: P7 keystone — the IA collapse is the most visible structural change of the rework.
- **done_criteria**:
  - Council verdict logged
  - Flag-gated rollout: existing nav remains default until promoted

## [BL-021] P8.a — Dashboard widget removal

- **parent_plan_id**: P8
- **phase**: P8
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: none
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Remove Run Activity Chart, raw cost widget, activity feed from dashboard. Move Permission Coach to Setup.
- **why_now**: P8 clears dashboard noise so P8.b and P8.c have room to land.
- **done_criteria**:
  - Removed widgets no longer render
  - Permission Coach reachable from Setup
  - No dead code left in Dashboard.tsx

## [BL-022] P8.b — "What we shipped yesterday" widget (Haiku-generated)

- **parent_plan_id**: P8
- **phase**: P8
- **tier_declared**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-021]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New dashboard widget — 3-5 task completions from result events. Generated by Haiku. Founder-language summary.
- **why_now**: P8 — replaces the activity feed with a founder-language outcome list.
- **done_criteria**:
  - Widget renders 3-5 outcomes from last 24h
  - Generated daily via Haiku cron; cached per-tenant per-day

## [BL-023] P8.c — Top Blockers + Quick Wins widgets

- **parent_plan_id**: P8
- **phase**: P8
- **tier_declared**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-021]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Top Blockers (agents waiting on founder input). Quick Wins (LLM-suggested 3 small things you could ask the team today, based on connected integrations).
- **why_now**: P8 — what should I do next today? founder-facing answer on the dashboard.
- **done_criteria**:
  - Top Blockers reads from agent-pending-input state
  - Quick Wins is Haiku-generated; cached per-tenant
