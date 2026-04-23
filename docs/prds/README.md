# Product Requirement Documents (PRDs)

Every non-trivial feature in FounderOS ships with a PRD — a scope contract between founders and the codebase. PRDs prevent scope creep, document decisions, and serve as a reference when features break or need iteration.

## Policy

- **Required for:** New page, new API endpoint, material workflow change, integration.
- **Not required for:** Bugfix, copy tweak, style polish, internal refactor, dependency update.
- **When in doubt:** Write a PRD. It takes 20 minutes and saves hours of rework.

## Structure

Each PRD follows the [template](template.md):
- **Problem** — Who is in pain, how often, how much?
- **Goal** — One sentence: what "done" looks like.
- **Non-goals** — What we explicitly cut.
- **User stories** — 3-7 stories in "As a / I want / so that" format.
- **Success metrics** — Quantifiable, not "users are happy."
- **UX / Flow** — Step-by-step walkthrough, edge cases.
- **API / Data contract** — Tables, endpoints, events.
- **Risks & open questions** — Scaling, third-party, unknowns.
- **Out of scope (but considered)** — What we talked about and cut.
- **Test plan** — Manual click-through + E2E tests that must pass.

## Naming

- File: `PRD-NNN-short-title.md` (zero-padded number for sorting)
- PR template requires: "Linked PRD: PRD-NNN" or "No PRD — <reason>"

## Shipped PRDs

| # | Title | Status | Owner | Ship Date |
|---|-------|--------|-------|-----------|
| 001 | Decision Inbox | Shipped | @vinamr | Wave 10 |
| 002 | Composio integration layer | Shipped | @vinamr | Wave 21 |
| 003 | Founder-native onboarding (6-step) | Shipped | @vinamr | Wave 15A |

---

**Last updated:** 2026-04-21
