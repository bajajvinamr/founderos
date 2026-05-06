# ADR-012 — FounderOS MVP cutover (DoubtBuddy 6-sprint scope)

## Status

Proposed (2026-05-06)

<!-- Originally framed as "ADR-013" in PHASE-S6 spec; numbered 012 to be
sequential with existing ADRs (011 was last). Renumber if needed. -->

## Context

FounderOS is the $4k buyer-funded Paperclip whitelabel for DoubtBuddy. Six sprints (S1–S6) shipped end-to-end:

- **S1 — foundation:** instance bootstrap, board API keys, RBAC, tenant isolation.
- **S2 — integrations:** Composio v3, integration ingest, event-ingest singleton, dedup-key contract.
- **S3 — agent runtime:** four default agents (CoS / growth / content / finance), heartbeats, daily brief, magic-activation gate.
- **S4 — content + CRM:** content briefs + drafts + scheduling, churn-rescue (S4.8 — autonomous revenue-rescue loop, council-gated, 8 prereq commits + dispatcher + generator + trigger + E2E).
- **S5 — finance:** revenue cockpit, churn forecast, runway model, pricing simulator, LTV/CAC, experiment ROI rollup, cash planning, scenario chat (LLM tool-use), console consolidation.
- **S6 — ops + polish (this sprint):** permissions matrix (S6.1), workflow-aware approvals + autonomy promotion gate (S6.2), audit lineage (S6.3), agent memory (S6.4), named workflow templates (S6.5), notifications data layer (S6.6), magic-link tokens (S6.7), onboarding draft persistence (S6.8), bug bash (S6.9). S6.10 is this ADR.

The MVP target was "ready for 20-50 design partners." That target is now structurally met:
- 100 migrations land cleanly with correct journal sequencing.
- Test suite: 2790 tests across 376 files; 2781 passing, 7 skipped, 2 known-flake-logged (1 pre-existing pg_dump round-trip issue, 1 fixed in S6.9).
- Authn (Better-Auth + Supabase) + tenant isolation + composite-FK same-tenant invariants in place.
- Per-instance Anthropic key support; BYO runner pattern; Composio v3 cross-org isolation closed.
- Single-origin Fly deploy (`founderos.fly.dev`), Vercel as 301 redirect, build-time env vars eliminated.

What remains is **operational** — Stripe live key flip, design partner outreach, first-week-of-customer support runbook — not engineering.

## Decision

**Mark FounderOS MVP scope-complete on 2026-05-06 with the 6-sprint scope above.** Hand the codebase to the buyer with:
1. ADR-012 (this) as the cutover decision record.
2. `docs/ops/design-partner-onboarding-kit.md` as the buyer's playbook.
3. CONTINUE.md as the canonical "what's next" surface.
4. Branch `feat/s4.3-content-attribution` (current working branch) as the integration target — once merged to `main`, the next deploy via `fly deploy -a founderos --strategy immediate` ships the full S6 cutover.

**Deferred to v1.1** (logged in CONTINUE.md, not blocking MVP):
- 6 consumer-side wires for the data layers shipped in S6.4–S6.8 (UI bell + WS push, Slack daily summary cron, email-template magic-link issuance, /brief route token consumption, wizard rewiring to draft API, embedder for memory cosine recall).
- backup-lib pg_dump duplicate-FK-reference flake (Known Flake #7 — does not affect Fly MPG PITR backups).

**Hard user-only halt:** Stripe live key flip. The kit documents the procedure; the buyer or operator executes it after billing posture is verified. Do NOT execute autonomously.

## Consequences

**What gets easier:**
- Buyer hand-off has a single source of truth (kit + ADR + CONTINUE).
- The 6 deferred consumer-wires are each independently shippable against stable contracts — half-day each, no architectural risk.
- v1.1 scope is documented before MVP ships, so feature creep into v1.0 is closed off.
- The "MVP ready for design partners" claim is grounded in concrete green gates, not aspiration.

**What gets harder:**
- Buyer must execute Stripe live key flip + first design partner outreach. The kit lowers but doesn't eliminate that lift.
- Operational work is now the bottleneck — engineering can't keep adding scope without breaking the cutover line.
- Future divergence between the buyer's whitelabel needs (DoubtBuddy branding, marketing site) and the engineering codebase will need its own contract.

**New risks / obligations:**
- **CI billing exhausted since 2026-05-02** — local gates green; deploy-prod.yml is the source of truth. Buyer must restore CI billing before relying on automated checks at PR time. Logged in CONTINUE.md as standing decision #3.
- **Stripe webhook → triggerChurnRescue() wire-up** — present in S4.8 commit ladder but gated behind a per-tenant config decision (auto-fire on every cancellation or opt-in via active workflow row). Recommendation in CONTINUE: latter. Buyer decides.
- **Design partner pipeline** — kit includes outreach template + first-week timeline, but actual partner identification + signing is buyer-side.

**Downstream:**
- ROADMAP.md S6 row should be marked "shipped 2026-05-06" once this ADR merges.
- Vanta `/vanta-sync` should run after this ADR + onboarding kit merge to capture the cutover learnings into invariants.

## Alternatives considered

- **Cut scope earlier and ship at S5** — would have missed the load-bearing trust pieces (permissions matrix, audit lineage, agent memory, magic-link auth). Design partners wouldn't have approval workflows or audit trails — both prerequisites for the "20-50 design partners" target.
- **Ship S6 minus the consumer-wires** (current decision) **vs. couple data + wire commits per ticket** — coupling means a single infra failure (BullMQ, WS server, email sender, Composio Slack auth) blocks the whole ticket. Decoupled lets each wire land independently. The cost is "founder doesn't see the bell ring yet"; the benefit is 4-of-5 tickets land green instead of 1-of-5 flaky.
- **Extend S6 to cover full E2E + Lighthouse + ARIA pass** — would push cutover by 2-3 days for diminishing returns. The S6.9 spec explicitly capped bug bash at 1 day with v1.1 spillover; extending would violate that gate.
- **Self-execute Stripe live key flip via stored test keys** — explicitly forbidden by LRP V2 ("hard user-only halt"). The blast radius of an autonomous live-key flip (test-mode payments leaking to production webhook handlers, bad customer charges) is a one-way door; the kit documents the procedure for the buyer to execute knowingly.
