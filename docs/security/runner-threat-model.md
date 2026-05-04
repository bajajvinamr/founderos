# Runner Threat Model — BYO-003

**Status:** Sprint 0 deliverable for ADR-011 BYO Runner architecture.
**Last updated:** 2026-05-04
**Owners:** Tech Lead (model), Security (review of M1 implementation), Backend (mitigations).

This document enumerates the trust boundaries the runner introduces, the
threats against each boundary, and the mitigation that lives in code. It
exists so `BYO-601 — Security review of M1` has a concrete checklist to
verify against, instead of starting from a blank page after the code
already shipped.

---

## Trust boundaries

```
┌───────────────────────────┐    Internet    ┌───────────────────────────┐
│  Cloud (Fly + Supabase)   │ ◄────────────► │  User's laptop            │
│                           │                │                           │
│  Trust:                   │                │  Trust:                   │
│   - Code we deploy        │                │   - Their own filesystem  │
│   - Drizzle / SQL queries │                │   - claude CLI binary     │
│   - Pino logs             │                │   - npm registry (signed) │
│   - Sentry breadcrumbs    │                │                           │
└───────────────────────────┘                └───────────────────────────┘
            ▲                                            ▲
            │ runner-token bearer                        │ npm install
            │ (scoped to one company)                    │ founderos-runner
            └────────────────────────────────────────────┘
```

Three boundaries matter:

1. **Cloud ↔ Runner over the bearer token.** Where the token leaks, gets
   replayed, or escalates beyond its company scope.
2. **Runner ↔ User's filesystem.** Where prompts spawn `claude` with flags
   that could exfiltrate or destroy local data.
3. **npm registry → User's laptop.** Where supply-chain attacks on the
   `@founderos/runner` package compromise the user's machine.

---

## Threats and mitigations

### T1. Token exfiltration via logs or screenshare

**Scenario:** A founder pastes the token in a screencast. The token is in their
shell history. A telemetry event accidentally captures it. Anyone with the
plaintext can act as that company's runner indefinitely.

**Mitigations:**

- **M1.1** Token is shown plaintext exactly once at issuance (`POST
  /companies/:id/runner-tokens` returns it in the response body; UI displays it
  in `<RunnerInstallCard />` with an explicit "shown once" warning).
- **M1.2** Server stores only `sha256(token)` (column `runner_tokens.tokenHash`).
  Plaintext is never logged. Verified by grepping for `tokenHash` and `fos_` in
  every log statement during BYO-601 audit.
- **M1.3** Constant-time compare on lookup (`crypto.timingSafeEqual`) — same
  pattern used by `oauth-state.ts`.
- **M1.4** One-click revoke: `DELETE /companies/:id/runner-tokens/:tokenId`
  flips `revokedAt`; subsequent uses 401. Surfaced prominently in dashboard.
- **M1.5** Audit log entries on `runner.token.issued` AND first use AND
  `runner.token.revoked`. If a leaked token is used from an unexpected IP,
  the audit row is the forensic anchor.
- **M1.6** Token format `fos_<32-char>` is gitleaks-detectable; we add a
  custom rule in the next gitleaks pass so an accidental commit gets caught
  by CI before push.

**Residual risk (accepted):** A motivated attacker who screenshares the token
can use it until the founder revokes. v2 mitigation: short-lived JWT minted
from a refresh token (90-day rotation).

---

### T2. Token escalation across companies

**Scenario:** A user with admin rights at Company A obtains a token for
Company B (e.g., they're a member of both, or social engineering). Token
should not let them act as Company B agent runtime when their session was
issued for Company A.

**Mitigations:**

- **M2.1** Token is bound to ONE companyId at issuance. The auth middleware
  resolves token → tokenId + companyId; subsequent route handlers use
  `req.actor.companyId` (NOT a path parameter) for all DB queries. Path-
  parameter `:id` is verified to match `req.actor.companyId` before any
  side effect.
- **M2.2** Cross-company test (`tests/runner-token-cross-company.test.ts`)
  creates Company A + Company B, issues token for A, attempts to claim a job
  for B → asserts 404.
- **M2.3** Composio precedent: `composio-skill-bridge.ts` was flagged in the
  2026-05-03 council for picking arbitrary `connectedAccountId` across orgs
  (still on Phase 1 backlog). The runner adapter MUST NOT inherit that bug —
  every job query is scoped by `req.actor.companyId`.

**Residual risk (none).** Cross-company is a hard 404; verified at the auth
middleware layer.

---

### T3. Prompt injection driving the user's `claude` to do bad things

**Scenario:** An attacker who can write to a company's Issues table (e.g., a
compromised integration like Composio Slack bot) injects a prompt that, when
the runner spawns `claude`, exfiltrates the user's local files to a remote
server via a curl tool call.

**Mitigations (v0):**

- **M3.1** Runner spawns `claude` with `--dangerously-skip-permissions`.
  This is the existing behavior of `claude-local` adapter; v0 mirrors it.
  We accept the same trust assumption: the user's heartbeat scheduler in
  the cloud is trusted to enqueue safe prompts.
- **M3.2** Skills the agent can use are scoped to what's installed in the
  user's `~/.claude/skills/`. The runner does NOT auto-install skills.
- **M3.3** Workspace path is the user's chosen agent home. `--add-dir` is
  scoped to that workspace; runner refuses `--add-dir` paths outside
  `$HOME` to prevent `--add-dir /` mass exfil.

**Mitigations (v1, deferred to follow-up sprint):**

- **M3.4** Server-side tool-call governance moves from post-facto stdout
  parsing (`heartbeat.ts:2235`) to pre-execution allow/deny on the runner's
  event POSTs. Runner blocks tool execution on the local side until cloud
  acknowledges via `/api/runner/jobs/:id/tool-decision`.
- **M3.5** Prompt-injection guard at the dispatch boundary (currently a
  Phase 1 backlog item per CLAUDE.md). When implemented, it runs against the
  prompt before it's enqueued for the runner.

**Residual risk (high in v0, declared):** A compromised integration that can
write to Issues can drive the user's local agent. This matches the existing
trust model of `claude_local`, so we are not regressing — but we are also
not improving until M3.4/M3.5 land.

---

### T4. Replay of completed jobs

**Scenario:** Attacker replays a captured `POST /api/runner/jobs/:id/complete`
to re-mark a different job as completed, or to suppress a real failure.

**Mitigations:**

- **M4.1** Job ID is scoped to a company; an attacker with a token for
  Company A cannot complete jobs for Company B (T2 mitigation).
- **M4.2** Server rejects double-completion: `runner_jobs.status` is checked
  before update; if already terminal, returns 409 with current state.
- **M4.3** Server rejects completion from a token that didn't claim the
  job: `claimedByTokenId` must equal `req.actor.tokenId`.
- **M4.4** Event POSTs are append-only with server-side monotonic `seq` per
  job. A replayed event with the same `eventId` is a no-op (idempotent).

**Residual risk (none).** Replay is a 409 or a no-op.

---

### T5. Network-level token interception (MITM)

**Scenario:** Attacker on the user's network intercepts the bearer token in
flight.

**Mitigations:**

- **M5.1** Cloud is HTTPS-only (Fly's built-in TLS termination + HSTS via
  `_headers`). Runner refuses to connect to non-HTTPS cloud URLs unless
  `--insecure` is passed (dev-only).
- **M5.2** Runner pins the cloud cert? — **No** in v0. We rely on the OS
  certificate store. Pinning requires a runner update on cert rotation,
  which is a worse trade than relying on TLS PKI. Documented as accepted.
- **M5.3** Token leak via TLS-stripping proxies: if the user's corporate
  network MITMs the connection, the token is in their proxy logs. Out of
  scope for FounderOS — that's the user's network operator's threat model.

**Residual risk (accepted).** TLS is sufficient for the SaaS threat model.

---

### T6. Supply chain — npm package compromise

**Scenario:** Attacker publishes a malicious version of `@founderos/runner`
to npm and users `npm install` it.

**Mitigations:**

- **M6.1** The runner is published from CI (BYO-401) using a scoped `NPM_TOKEN`
  with publish-only permissions; no human laptop credentials in the publish
  path. CI workflow is in-repo and code-reviewed.
- **M6.2** Package version is pinned via the install command we show in the
  install card: `npx @founderos/runner@<exact-version>`. `latest` is
  available but the recommended copy-paste is pinned.
- **M6.3** Provenance attestations on every publish (npm's `--provenance`
  flag) so users can verify the build originated from our GitHub repo.
- **M6.4** Publish workflow has a `dry-run` step on PRs that catches obvious
  badness before tag-push triggers the real publish.

**Residual risk (low, residual).** A determined attacker who compromises
GitHub Actions can still publish. The `--provenance` attestation is the
detection mechanism, not a hard prevention.

---

## What BYO-601 will verify against this document

The Security review ticket runs through this list and asserts:

- [ ] Token never appears in any log statement (T1.M1.2)
- [ ] `crypto.timingSafeEqual` used in lookup (T1.M1.3)
- [ ] Audit rows written for issuance + first-use + revoke (T1.M1.5)
- [ ] Cross-company token use → 404, no information leak (T2.M2.1, T2.M2.2)
- [ ] Path-param companyId verified against `req.actor.companyId` (T2.M2.1)
- [ ] `--add-dir` path validation against `$HOME` boundary (T3.M3.3)
- [ ] Double-completion → 409 (T4.M4.2)
- [ ] Mismatched `claimedByTokenId` → 403 (T4.M4.3)
- [ ] Event idempotency on `eventId` (T4.M4.4)
- [ ] Runner refuses non-HTTPS cloud URLs (T5.M5.1)

Findings are tracked in `docs/security/runner-m1-audit.md` (created during
the BYO-601 review) and any P0/P1 are blocking on M1 merge.

---

## Out of scope (declared, not mitigated)

These are real risks that we accept, document, and revisit later:

- **TLS-stripping corporate proxies** — User's network problem.
- **Compromised user laptop** — If the user's machine is owned, the runner
  is the least of their problems. Same trust model as `claude_local`.
- **Token rotation** — v0 has revoke-and-reissue. Auto-rotation with
  refresh tokens is a v2 feature.
- **Per-runner IP allowlist** — Useful in enterprise. Out of scope for the
  current SMB-founder buyer segment.
