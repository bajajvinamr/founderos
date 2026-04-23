# Architecture Decision Records

Short, dated notes on the material decisions made while building FounderOS. If you're new to the repo (or you're me in six months and don't remember why we did something), start here.

Format is [Michael Nygard's ADR template](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md): **Context → Decision → Consequences → Alternatives**. One page each. Plain English.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [001](./001-fork-paperclip.md) | Fork Paperclip as the base, rebrand as FounderOS | Accepted | 2026-04-21 |
| [002](./002-pnpm-monorepo.md) | pnpm monorepo over multi-repo | Accepted | 2026-04-21 |
| [003](./003-fly-vercel-split.md) | Fly.io for the backend, Vercel for the UI | Accepted | 2026-04-22 |
| [004](./004-supabase-auth.md) | Supabase for auth, not build-our-own | Accepted | 2026-04-22 |
| [005](./005-byo-anthropic-key.md) | BYO Anthropic key per customer | Accepted | 2026-04-22 |
| [006](./006-permission-ladder.md) | Permission ladder: observe / draft / approve / autonomous | Accepted | 2026-04-22 |
| [007](./007-decision-inbox.md) | Decision Inbox as the primary founder surface | Accepted | 2026-04-22 |
| [008](./008-composio-integrations.md) | Composio as the integrations layer (additive) | Accepted | 2026-04-23 |
| [009](./009-tenant-isolation.md) | Tenant isolation via `req.actor.companyIds` + route-level assertion | Accepted | 2026-04-23 |
| [010](./010-managed-services.md) | Managed services where OAuth/security sprawl is the risk | Accepted | 2026-04-23 |

## How to add a new ADR

1. Copy [`template.md`](./template.md) to `NNN-kebab-title.md` where `NNN` is the next free number (zero-padded).
2. Fill it in. Keep it under a page — if you need more, you're probably writing a design doc instead.
3. Add a row to the index table above.
4. Set status to **Proposed** while you circulate, flip to **Accepted** once the call is made. If a later ADR overturns this one, change the status to **Superseded by ADR-NNN** rather than deleting it.
5. Link the new ADR from anywhere that references the decision (runbooks, handover, etc.).

## Status meanings

- **Proposed** — written down, not yet committed to. Safe to push back.
- **Accepted** — we're doing this. Change requires a new ADR.
- **Deprecated** — no longer followed, but kept for history.
- **Superseded by ADR-NNN** — replaced by a later decision. Read the successor for current thinking.

## Related docs

- [`HANDOVER.md`](../../HANDOVER.md) — what exists today, what's still broken
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — how to ship
- [`docs/INTERVIEW-DEMO.md`](../INTERVIEW-DEMO.md) — the 90-second and 5-minute demo scripts
