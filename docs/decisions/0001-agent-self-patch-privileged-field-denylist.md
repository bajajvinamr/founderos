# ADR 0001 — Agent self-PATCH privileged-field denylist

**Date:** 2026-05-07
**Status:** Accepted (autonomous CTO call per week-long dream-state hardening directive)
**Decision-maker:** CTO agent (week-long run, Cycle 1)

## Context

The 2026-05-07 dream-state hardening discovery run found a P0 escalation chain
in `PATCH /agents/:id` (`.qa/synthesis.md` finding P0-1, captured by 3
independent discovery agents):

1. `assertCanUpdateAgent` short-circuited with `if (actor.id === target.id) return;`
   (`server/src/routes/agents.ts:364` pre-fix), so agents were trusted to PATCH themselves.
2. `updateAgentSchema` accepted `role`, `status`, `budgetMonthlyCents`,
   `spentMonthlyCents`, `reportsTo`, `permissionLevel`
   (`packages/shared/src/validators/agent.ts:74-83`).
3. Combined: an agent could `PATCH /agents/<self>` with `{role: "ceo"}` →
   triggering the `actorAgent.role === "ceo"` blanket-grant on
   `assertCanUpdateAgent` (`agents.ts:365`) → unlocking company-wide agent
   mutation, including raising its own budget, un-pausing itself, and
   mutating siblings.

Three dream-state safety invariants violated by one chain:
- "agent cannot escalate to founder/admin role" (FOUNDEROS-CRITICAL-FLOWS §4)
- "no agent self-approval" (§7) — closed for the issue lifecycle, but the
  primitive here was the role-escalation that downstream unlocks self-approval
- "budget hard-stop tested" (§10)

## Decision

Add a **denylist** of privileged fields that an agent cannot set on itself
via `PATCH /agents/:id`, enforced by a new helper `assertNoPrivilegedSelfPatch`
that runs BEFORE `assertCanUpdateAgent` so the self-short-circuit cannot
approve a payload that contains a privileged field.

Denylisted fields (any one present in body → 403):

- `role`
- `status`
- `budgetMonthlyCents`
- `spentMonthlyCents`
- `reportsTo`
- `permissionLevel`

Founders (board actor) and other agents with explicit grants remain free to
PATCH these fields on a target. Only **agents PATCHing their own row** are
gated by this denylist.

## Why Conservative

Per the week-long directive's rule for product-adjacent ambiguity:

> If unsure whether an agent can do X, default to "agent cannot."

The self-PATCH guard is the conservative choice. An agent has no legitimate
need to set its own `role`, change its own `status`, raise its own budget,
or rewrite its own `reportsTo`. Any future use case that needs one of
these (e.g. an "agent quits" flow) would route through a dedicated endpoint
with explicit policy semantics, not a generic PATCH.

## Alternatives Considered

### A. Allowlist (preferred long-term)

Restrict self-PATCH to a small set of safe fields (`name`, `title`, `icon`,
`capabilities`, `desiredSkills`).

**Why not now:** existing tests and possibly existing integrations (per
the W1-W6 stashed work) PATCH multiple fields in the same call. An
allowlist would require auditing every caller, which exceeds the scope of
a P0 close-out PR. The denylist is precise about the threat model and
small enough to reason about.

**Future:** the inline comment in `assertNoPrivilegedSelfPatch` instructs
reviewers to evaluate any new field added to `updateAgentSchema` against
this denylist. A follow-up PR can flip to allowlist once the broader
self-PATCH usage pattern is audited.

### B. Strip privileged fields silently from self-PATCH

Trim the body of privileged fields and let the rest of the PATCH proceed
with a 200.

**Why not:** silent stripping violates the directive's rule "If unsure
whether a failure should be silent, default to 'visible with next action.'"
A 403 with the field name in the error message gives the agent (and any
debugging operator) a clear signal: the request was rejected, here's why.

### C. Schema-level fix (separate `selfUpdateAgentSchema`)

Branch on the actor at validation time and apply a different schema.

**Why not:** Express middleware ordering puts `validate(updateAgentSchema)`
on the route at registration time, before the request handler runs. Branching
the schema would require a custom middleware that inspects `req.actor` first,
which adds complexity. The route-handler guard achieves the same security
property with less change.

### D. Block self-PATCH entirely

Reject any agent from PATCHing its own row.

**Why not:** there are legitimate self-edits (display name, title, icon,
capabilities) that founders may want agents to control. Cutting them off
entirely would remove a UX affordance without proportional security benefit.

## Tests Added

`server/src/__tests__/agents-self-patch-escalation.test.ts` — 10 tests:

**Reject (privileged self-PATCH):**
- self-PATCH `{role: "ceo"}` → 403
- self-PATCH `{status: "active"}` (paused → active) → 403
- self-PATCH `{budgetMonthlyCents: 999999999}` → 403
- self-PATCH `{spentMonthlyCents: 0}` → 403
- self-PATCH `{reportsTo: <sibling-id>}` → 403
- self-PATCH `{permissionLevel: "autonomous"}` → 403
- self-PATCH `{title: "...", role: "ceo"}` (mixed payload) → 403

**Allow (benign self-edit + boundaries unaffected):**
- self-PATCH `{title: "..."}` → 200
- board PATCH `{role, status}` on agent → 200
- agent with role=ceo PATCH on sibling `{role}` → 200

The mixed-payload test pins the policy that ANY privileged field present
rejects the entire request — there is no partial-apply.

## Follow-Up Needed

**Out of scope for PR-1, queued for later cycles:**

1. **Audit-log emit on rejected self-PATCH attempts** (synthesis P1-C4).
   When the guard fires, write `agent.privileged_self_patch_blocked` to
   `activity_log` so founders can see attempted escalations.
2. **Service-layer transition allowlist** (synthesis P1-B3). Defense in
   depth: even if a future route bug bypassed the guard,
   `services/agents.ts:318` should refuse `paused → active` without an
   explicit unpause path.
3. **`actorAgent.role === "ceo"` blanket-grant audit** (synthesis P0-1
   secondary). Confirm whether legitimate use cases need this grant; if
   not, replace with explicit creator-grants only. Currently kept
   intact because the role-escalation primitive is closed by this PR.
4. **Self-approval guard on standalone `/approvals/:id/approve`** —
   investigation showed `assertBoard` already gates the route, but
   `req.body.decidedByUserId` is trusted for audit attribution. Separate
   ticket.
5. **Allowlist flip** — once the codebase audit confirms the safe self-PATCH
   set, swap the denylist for an allowlist.

Each follow-up gets its own PR with its own ADR.
