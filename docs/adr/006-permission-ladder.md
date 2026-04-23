# ADR-006 — Permission ladder: observe / draft / approve / autonomous

## Status

Accepted (2026-04-22)

## Context

Founders want AI help but don't trust it to send real emails, move real deals, or post to real Slack channels on day one. A binary "agent is on or off" switch is too coarse — users either turn everything off (and get nothing) or turn it on (and get scared the first time something lands in prod). We need trust-building baked into the model.

## Decision

Every agent has one of four permission levels, picked per-skill or per-agent:

1. **Observe** — read-only. Reads data, surfaces comments, never writes.
2. **Draft** — proposes work as decisions in the Decision Inbox. Never executes.
3. **Approve** — executes pre-approved patterns. Asks on net-new work.
4. **Autonomous** — executes within scope. Asks only on cross-department or budget-exceeding actions.

New agents default to draft. An autonomy coach card on the Dashboard watches approval history — after N clean approvals for a given skill, it suggests promoting the agent to `approve`. Promotion is one click, reversible.

## Consequences

- Founders onboard at low trust and ratchet up as the agent proves itself. Matches how humans hire.
- Every skill has to be annotated with the permission level it requires, and the router has to check before invocation. One more surface to maintain, but it's ~30 lines of middleware.
- The Decision Inbox carries real weight — it's where `draft` agents live. See ADR-007.
- Autonomy-coach recommendations are suggestive, never forced. A founder who wants everything manual can stay at draft forever.
- The ladder is legible to customers in sales conversations — "you control exactly how much autonomy each agent has" is a strong sound bite vs. competitors with an on/off switch.

## Alternatives considered

- **Binary off/on** — the default of most agent platforms. Fails the trust-building test.
- **Single "require approval for all"** — safe, but unusable at scale with 20 agents. The inbox floods.
- **Chatops-style (agent asks in Slack, human replies)** — fine for chat-first teams, but founders are often not in Slack when agents run. Loses async-first benefits.
- **Scoped tokens per skill (no agent-level permission)** — correct in theory, but the UX of managing per-skill tokens is awful. Agent-level with per-skill override is the right level of granularity.
