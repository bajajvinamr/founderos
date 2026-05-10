# CI Watch

PR status snapshot maintained by the chief-of-staff each cycle. Single source of truth for "what's in flight and what's its CI state."

**Schema per entry**:
```
## #<pr> — <title>
- branch: <feat/...>
- state: <OPEN|MERGED|CLOSED>
- merged_at: <iso ts | null>
- merge_state: <MERGEABLE|BLOCKED|BEHIND|UNKNOWN>
- ci: { SUCCESS: N, FAILURE: N, PENDING: N }
- auto_merge: <enrolled|not_enrolled>
- last_checked: <iso ts>
- notes: <flake history, retries, etc.>
```

---

## Cascade PRs (pre-activation tracking)

### #161 — Rename google_api → gemini_api
- state: MERGED
- merged_at: 2026-05-10T14:58:08Z

### #164 — OpenAI API adapter runtime
- state: MERGED
- merged_at: 2026-05-10T15:11:48Z

### #163 — Register openai_api + gemini_api adapters
- state: OPEN
- merge_state: BEHIND
- ci: { SUCCESS: 18, FAILURE: 4 (deps unmerged) }
- auto_merge: enrolled
- notes: Awaiting #165 merge. Once #165 lands, run `gh pr update-branch 163` — failures should clear.

### #165 — Gemini API adapter runtime
- state: OPEN
- merge_state: BLOCKED (slow CI re-running on rebase)
- ci: { SUCCESS: 20 (pre-rebase), PENDING }
- auto_merge: enrolled

### #167 — B1 follow-up: map all 6 live tiles in mapProviderToAdapter
- state: OPEN
- merge_state: BLOCKED
- ci: { SUCCESS: 17, PENDING: 2 }
- auto_merge: enrolled
- notes: Cycle 2 retrigger after postgres-teardown flake.

### #168 — B3: Composio promote primary CTA
- state: OPEN
- merge_state: BLOCKED
- ci: { SUCCESS: 18 (commit 42f445b), then re-running for f289c77 }
- auto_merge: enrolled
- notes: Cycle 3 fresh fix (require→import + vi.waitFor for async queries). Local test 5/5 pass.

### #169 — P1: Display Dictionary infrastructure
- state: OPEN
- merge_state: BLOCKED
- ci: { SUCCESS: 20, re-running on rebase }
- auto_merge: enrolled
