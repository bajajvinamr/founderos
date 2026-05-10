# Council Log

Major decisions that hit the adversarial council (Gemini + Codex) or were escalated to user. Append-only chronological log.

**Schema per entry**:
```
## [CL-NNN] <iso ts> — <topic>

**Decision**: <what was decided>
**Source**: <auto-loop | autoloop-orchestrator | user-signoff | shadow-council-hook>
**Reviewers**: <gemini | codex | both | user>
**Verdict**: <PASS | FAIL | DEFERRED | CONDITIONAL>
**Rationale**: <why>
**Artifacts**: <files, PRs, COUNCIL.md, SIG-NNN>
```

---

## [CL-001] 2026-05-11T00:00:00Z — Autoloop protocol design

**Decision**: Run an 8-hour autonomous loop with chief-of-staff + product + engineering roles per `PROTOCOL.md`.
**Source**: shadow-council-hook (PostToolUse on Write of PROTOCOL.md)
**Reviewers**: gemini + codex (in-flight via background agent a0c995f21df5eb688)
**Verdict**: pending (background review running)
**Rationale**: PROTOCOL.md keyword-matched on auth/payment/migration. Hook flagged for council. User authorized parallel review while scaffold continues. Findings will land in `.planning/autoloop/COUNCIL.md` when complete.
**Artifacts**: PROTOCOL.md, COUNCIL.md (in flight)
