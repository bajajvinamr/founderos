# Product Backlog

Items the product team has identified for engineering. The chief-of-staff drains queued Tier-1 items into `eng-queue.md`. Tier-2 items open a SIGNOFFS entry for human review before dispatch. Tier-3 items NEVER dispatch automatically — always SIGNOFFS as `tier-3-council`.

**Schema per entry**:
```
## [BL-NNN] <title>
- phase: <B2|B4|P2|P3|P4|P5|P6|P7|P8|other>
- tier: <1|2|3>
- complexity: <S|M|L>  (S=1-3 files, M=4-10, L=10+)
- files_estimate: <count>
- dependencies: <[BL-N, BL-M] | none>
- council_required: <true|false>
- status: <queued|dispatched|merged|blocked|cancelled>
- created: <iso ts>
- summary: <1-2 sentence why>
```

---

## [BL-001] B2 — server bootstrap honors chosen adapter

- **phase**: B2
- **tier**: 2
- **complexity**: S
- **files_estimate**: 3
- **dependencies**: none (independent of cascade — can dispatch first)
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/services/onboarding-bootstrap.ts:201` hardcodes `claude_local` regardless of the founder's chooser selection. Read the chosen adapter from the draft state and route correctly. Documented in FounderOS CLAUDE.md as "Onboarding adapter mismatch". Three audits flagged this in the locked plan.

## [BL-002] P2.a — Step 4 onboarding copy: founder-language headline + subtitle

- **phase**: P2
- **tier**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-006]  <!-- DisplayDictionary must exist on main first; #169 is the PR landing it -->
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Replace "Plug in your brain" Step 4 H1 with "How should FounderOS use AI?" + matching subtitle. Pure copy change. Uses DisplayDictionary keys from P1.

## [BL-003] P2.b — ProviderTile uses founder-language labels + brand logos

- **phase**: P2
- **tier**: 1
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: ProviderTile + ProviderChooser swap engineer-language strings ("Anthropic API", "Codex CLI") for DisplayDictionary keys ("Claude (pay-per-use)", "ChatGPT (subscription)"). Add brand logos (Anthropic/OpenAI/Google) instead of text.

## [BL-004] P2.c — Remove anthropic_api default in FounderOnboardingWizard

- **phase**: P2
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: none
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `FounderOnboardingWizard.tsx:82` initializes `adapterChoice: "anthropic_api"`. Change to `null` to force explicit founder choice (one of the 3 audit findings).

## [BL-005] P2.d — Tile descriptions in founder-language

- **phase**: P2
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-003]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Tile descriptions become "Claude (subscription) — uses your existing Claude Code app on your computer" style. Consume DisplayDictionary.

## [BL-006] B4 — provider key discriminated-union schema

- **phase**: B4
- **tier**: 3
- **complexity**: L
- **files_estimate**: 15
- **dependencies**: none
- **council_required**: true
- **status**: queued (will not dispatch — surfaces as SIG-NNN tier-3-council)
- **created**: 2026-05-11T00:00:00Z
- **summary**: Rename `anthropicKey` → discriminated union `{ provider, key }`. Touches packages/shared types, server routes (`onboarding.ts:291`, bootstrap), FounderOnboardingWizard, possibly migrations. One-way schema door. Locked plan explicitly council-gated.

## [BL-007] P3.a — Sidebar primary CTA: "Ask FounderOS"

- **phase**: P3
- **tier**: 2  <!-- council-required per locked plan ("Council at end of P0, P3, P7") -->
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-002, BL-003]
- **council_required**: true
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Sidebar.tsx:107 + MobileBottomNav.tsx:45 replace "New Issue" / "Create" with "Ask FounderOS" / "Ask". Primary surface for founders. Council before merge (one-way door — changes the primary CTA and founder mental model).

## [BL-008] P3.b — CommanderBar component (Cmd+K global Ask)

- **phase**: P3
- **tier**: 2
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-007]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `CommanderBar.tsx` at top of app. Cmd+K opens "Ask the team to do something...". Replaces buried "New Issue" flow as primary entry point.

## [BL-009] P3.c — Ask router service (Haiku-tier LLM)

- **phase**: P3
- **tier**: 2
- **complexity**: M
- **files_estimate**: 3
- **dependencies**: [BL-008]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/services/ask-router.ts` parses founder request → routes to correct department/agent. Haiku-tier (~$0.0001/route, ~500ms). Per-tenant rate-limit.

## [BL-010] P3.d — Two-mode NewIssueDialog (Founder default, Advanced disclosure)

- **phase**: P3
- **tier**: 2
- **complexity**: M
- **files_estimate**: 1 (large file)
- **dependencies**: [BL-009]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: NewIssueDialog.tsx (lines 1064, 1351, 1424 per plan) becomes business-ask + outcome + urgency + approval-pref by default. Advanced mode (assignee, project, model, workspace, thinking effort, reviewer) behind disclosure.

## [BL-011] P3.e — Ask templates empty-state

- **phase**: P3
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-010]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New AskTemplates.tsx — "Find why signups dropped", "Prepare investor update", "Draft LinkedIn posts", "Analyze churn", "Follow up with leads". Founder-language template list.

## [BL-012] P4.a — viewMode state + localStorage persistence

- **phase**: P4
- **tier**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Add `viewMode: 'founder' | 'engineer'` to RunTranscriptView. Persisted in `localStorage["founderos.viewMode"]`. Settings → Advanced toggle.

## [BL-013] P4.b — Founder transcript hides thinking/tool blocks

- **phase**: P4
- **tier**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-012]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: RunTranscriptView.tsx (lines 670, 692) hides TranscriptThinkingBlock, raw tool blocks, stderr_group (unless failed), init event (model/session). Engineer mode restores everything.

## [BL-014] P4.c — Tool action summarization helper

- **phase**: P4
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-013]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `summarizeTool()` helper — turns "Executing tool bash_run_command with input ls -la" into "📂 Browsing files…". Founder-friendly action text.

## [BL-015] P4.d — Run outcome summary card (Haiku-cached)

- **phase**: P4
- **tier**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-013]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `server/src/services/run-outcome-summary.ts` (Haiku, ~$0.0001/run). 1-line outcome + 3-bullet "what they did" generated from result event. Cached per-run. Top of every transcript.

## [BL-016] P5.a — AI Connections page scaffold

- **phase**: P5
- **tier**: 2
- **complexity**: M
- **files_estimate**: 4
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `ui/src/pages/AiConnections.tsx` — top-level nav item under Setup. Surfaces: Connected (chips with brand logos + status), Default for new work, Currently used by (per-department), Fallback order (drag-reorder).

## [BL-017] P5.b — Company-level preferred provider setting

- **phase**: P5
- **tier**: 2
- **complexity**: M
- **files_estimate**: 3
- **dependencies**: [BL-016]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `server/src/routes/companies.ts` + CompanySettings.tsx. NewAgent form respects company-level default. AgentConfigForm cross-warning when agent uses different provider than connected.

## [BL-018] P5.c — Intelligence Health status dots

- **phase**: P5
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: [BL-016]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New `IntelligenceHealth.tsx` on dashboard — Claude ✅, OpenAI ✅, Gemini ❌. Reads connected adapters + last-call success.

## [BL-019] P6.a — Composio catalog by business question

- **phase**: P6
- **tier**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-002]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: `packages/shared/src/constants.ts:924` + `Integrations.tsx:418`. Reorganize integration catalog: Revenue (Stripe), Growth (PostHog/LinkedIn), Sales (HubSpot), Team comms (Slack), Knowledge (Notion). Cards show outcome ("Lets FounderOS explain churn").

## [BL-020] P7 — IA collapse (6-bucket nav)

- **phase**: P7
- **tier**: 3
- **complexity**: L
- **files_estimate**: 10
- **dependencies**: [BL-007, BL-016]
- **council_required**: true
- **status**: queued (will not dispatch — SIGNOFFS tier-3-council)
- **created**: 2026-05-11T00:00:00Z
- **summary**: Collapse ~25 nav items into 6 buckets (Home / Ask / Decisions / Work / Setup / Advanced). Feature-flagged `VITE_FOUNDEROS_SIMPLIFIED_NAV`. Primary nav structure = one-way door. Locked plan explicitly council-required.

## [BL-021] P8.a — Dashboard widget removal

- **phase**: P8
- **tier**: 1
- **complexity**: S
- **files_estimate**: 1
- **dependencies**: none
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Remove Run Activity Chart, raw cost widget, activity feed from dashboard. Move Permission Coach to Setup.

## [BL-022] P8.b — "What we shipped yesterday" widget (Haiku-generated)

- **phase**: P8
- **tier**: 2
- **complexity**: M
- **files_estimate**: 2
- **dependencies**: [BL-021]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: New dashboard widget — 3-5 task completions from result events. Generated by Haiku. Founder-language summary.

## [BL-023] P8.c — Top Blockers + Quick Wins widgets

- **phase**: P8
- **tier**: 1
- **complexity**: S
- **files_estimate**: 2
- **dependencies**: [BL-021]
- **council_required**: false
- **status**: queued
- **created**: 2026-05-11T00:00:00Z
- **summary**: Top Blockers (agents waiting on founder input). Quick Wins (LLM-suggested 3 small things you could ask the team today, based on connected integrations).
