<!-- Template source: docs/code-review-practices.md §3 — keep aligned -->
<!-- AI sample-N reviewer-agent posts a separate review event regardless of human checklist completion -->

## Summary

<!-- One-paragraph "what + why" of this PR. Combine context (the existing problem or feature gap) with the change (what this PR does). -->

## Tier classification

- [ ] **Tier 1** — copy/label/test/doc-only; auto-merge eligible per `.planning/autoloop/PROTOCOL.md` §"Path-based tier rules"
- [ ] **Tier 2** — new surface (services, routes, pages, top-level components); user-merge required
- [ ] **Tier 3** — schema/migration/auth/billing/nav/cross-service contract; council-required, never auto-dispatched

**Why this tier:** <!-- 1-sentence justification. If your diff touches any Tier-3 path (see PROTOCOL.md), this is Tier 3 regardless of size. -->

## Surface affected

<!-- Bullet list of files/services/routes/UI surfaces touched. -->

### Routes changed (if applicable)

<!-- e.g., GET /api/foo, POST /api/foo/:id, new route mounted on instance/settings/* -->

### Migrations (if applicable)

<!-- Schema changes. List migration files. Note any non-additive operations (DROP, ALTER TYPE, etc.). -->

### Breaking changes (if applicable)

<!-- Anything that changes a public contract: API shape, env var name, exported type, plugin interface. -->

### Screenshots (UI changes only)

<!-- Attach 375px mobile + 1440px desktop screenshots for any visible UI change. -->

## Test plan

<!-- How was this verified? Include actual `pnpm` commands run, what assertions matter, what coverage looks like. -->

```bash
# Example
pnpm --filter @founderos/ui typecheck
pnpm --filter @founderos/ui test -- AiConnections
pnpm --filter @founderos/server test -- yesterday-summary
```

## Review checklist

- [ ] **Founder-language copy** — no engineer jargon in UI strings (per P2 phase; consult `packages/shared/src/display-dictionary.ts`)
- [ ] **Accessibility** — keyboard nav, aria-labels, disabled-state visual affordance (`opacity-60 cursor-not-allowed`), color contrast
- [ ] **Error handling** — fail loudly in dev, gracefully in prod; no silent catches; surface `requestId` in user-facing error messages
- [ ] **Secret management** — env vars only; no hardcoded keys or tokens; startup validation for any new required env
- [ ] **Tier-3 path check** — `git diff --name-only main...HEAD` does NOT touch forbidden surfaces (see PROTOCOL.md §"Path-based tier rules")
- [ ] **Test coverage** — real assertions for new code paths; mocks scoped per-test to avoid vitest cross-worker race (PROTOCOL.md flake taxonomy #11); use `vi.resetModules()` in `beforeEach` for mock-heavy suites
- [ ] **Single-origin guarantee** — does NOT re-introduce Vercel-split or cross-origin auth (per CLAUDE.md 2026-05-03 council)

## Rollback plan

<!-- How would we undo this if it breaks prod?
- Additive code: "revert this PR" is sufficient
- Schema changes: link the down-migration or document the manual reversal SQL
- Feature-flagged changes: name the kill-switch (e.g., `VITE_FOUNDEROS_FEATURE_X=0`)
- Stripe / billing / one-way doors: explicit step-by-step procedure
-->

## Related

- Backlog: <!-- BL-NNN -->
- SIGNOFFS: <!-- SIG-NNN (if Tier-2 review queue, Tier-3 council, or scope-expansion) -->
- Linked PRD: <!-- docs/prds/<file>.md -->
- Linked ADR: <!-- docs/adr/<file>.md -->
- Sister PR / dependency: <!-- #NNN -->
