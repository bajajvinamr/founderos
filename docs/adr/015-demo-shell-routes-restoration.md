# ADR-015 — Demo Shell Routes Restoration

## Status

Accepted (2026-05-15)

<!-- Supersedes P3 Wave 1 routing contract originally documented in handoff §2.2 -->

## Context

P3 Wave 1 collapsed six high-signal founder surfaces into `/today` as
redirects:

- `/dashboard` → `/today`
- `/brief` → `/today#brief`
- `/weekly` → `/today#weekly`
- `/decisions` → `/today`
- `/approvals` (+ `/pending`, `/all`) → `/today?view=queue&risk=high`
- `/conversations` → `/today`

The intent was opinionated minimalism: one entry point, one mental model.

In practice, two pressures broke this:

1. **Customer demos** — buyers expect named surfaces ("show me the
   Dashboard", "let me bookmark Brief") and a redirect-to-`/today`
   experience reads as buggy, not minimalist.
2. **Bookmark continuity** — early-access founders had bookmarks for
   `/brief` and `/weekly` from pre-Wave-1. Redirects broke those bookmarks.

Meanwhile, the navigation surface (Sidebar, FounderBriefing,
FirstRunProgressCard, etc.) had already been refactored to link
DIRECTLY to the named routes. The route table was the missing piece.

## Decision

Restore the six routes as first-class lazy-loaded pages. Two routes
stay folded into `/today`:

- `/inbox` → `/today` (genuinely subsumed — Today IS the decision queue)
- `/activity` → `/today` (Wave 3 will land at `/library/audit`)

## Consequences

**What gets easier:**
- Demos work as buyers expect — named surfaces, deep-linkable, bookmarkable.
- Navigation is no longer "lying" about where links lead.
- PR #251 (DailyBriefView UI) gains a real mount point at `/brief`.

**What gets harder / accepted tradeoffs:**
- Six additional code-split chunks load on direct navigation
  (mitigated: routes stay `lazy(() => import(...))`).
- The "everything in Today" narrative is partially walked back — Today
  remains the default surface, but is no longer the *only* surface.

**Neutral:**
- `wave1-redirects.test.tsx` (renamed to "Board routes") regression test
  covers both buckets — restored routes as lazy-loaded components, and
  the two retained folds.

## Alternatives considered

1. **Keep the folding, add named anchors** (`/today#dashboard`,
   `/today#brief`). Rejected — anchors don't survive Cmd+R reliably,
   and Today's component tree wasn't structured to conditional-render
   per anchor.
2. **Restore all routes including `/activity` and `/inbox`**. Rejected
   for now — Inbox is genuinely Today's decision queue, and Activity
   has a planned destination at `/library/audit` in Wave 3.

## References

- Commit: `3bdc64c` (original work)
- Related: PR #251 (DailyBriefView UI mounts at `/brief`)
- Superseded section: P3 Wave 1 handoff §2.2 (file does not exist
  in repo; this ADR is the source-of-truth going forward)
