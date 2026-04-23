# ADR-007 — Decision Inbox as the primary founder surface

## Status

Accepted (2026-04-22)

## Context

Raw Claude output is ephemeral. Early testers were copy-pasting agent proposals into Discord, losing track of what they'd approved, re-asking the same questions across sessions, and missing commitments. Paperclip gives you transcripts, not decisions — a transcript is a log; a decision is a crisp ask with a yes/no answer. We needed a first-class surface for the ask.

## Decision

Every proposal an agent can't resolve itself becomes a structured `Approval` row with proposal text, rationale, risk notes, and one call — approve or reject. The Decision Inbox (`/decisions`) is the queue. Approval routes the decision back to the agent on its next heartbeat for execution; rejection writes the rationale to Company Memory so the agent doesn't propose the same thing next week.

## Consequences

- Founders have one screen for the "what needs me?" question. Everything else is auto-running.
- Every rejection is training data for Company Memory — the agent learns from refusals, not just approvals.
- The inbox makes the permission ladder (ADR-006) real. `Draft`-level agents file here; `Approve`-level agents bypass here for pre-approved patterns.
- If the inbox fills up, founders get overwhelmed. Mitigated by the autonomy coach nudging agents up the ladder when they're trustworthy.
- Auto-ran decisions (agents at `autonomous` level who executed without asking) still appear in the inbox as an informational row — transparency without busywork.
- Every decision has a 6-hour follow-up cron that asks "what happened?" 14 days after approval. Closes the outcome loop.

## Alternatives considered

- **Chat transcript history** — what Paperclip does. Scales badly, hard to answer "what's pending for me today?" without skimming dozens of threads.
- **Email-only** — works but misses the structured approve/reject primitive and the outcome loop.
- **Runbook-style static docs** — fine for repeatable processes, wrong shape for one-off decisions that need a human call.
- **Slack ephemeral messages** — our first instinct, but the messages disappear. No audit trail, no queue, no follow-up loop. We still post approval requests to Slack as a notification surface — but the Inbox is the system of record.
