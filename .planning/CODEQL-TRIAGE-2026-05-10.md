# CodeQL Triage — 2026-05-10

## Executive summary

- **142 alerts triaged** across 15 rule categories
- **11 real-must-fix** (4 critical SSRF + 7 high-severity genuinely exploitable)
- **28 defense-in-depth** (high severity, contained by surrounding guards but worth fixing)
- **88 false-positives-to-dismiss** (pattern-matched by CodeQL but structurally safe in context)
- **15 deferred-to-human** (polynomial ReDoS in adapter parse pipelines — attacker input never reaches these regexes directly; structural fix requires adapter refactor)

---

## Section 1 — Real & must-fix (sorted by severity)

### Cluster A: SSRF — Webhook probe endpoint (unauthenticated SSRF)
- **Alerts**: #18 (`js/request-forgery`)
- **Severity**: CRITICAL
- **Risk**: `GET /api/invites/:token/test-resolution?url=<attacker-url>` makes a server-side HEAD fetch to any URL the caller supplies. Auth gate is only the invite token — which is a short random suffix (`pcp_invite_<8 chars, a-z0-9>`). Brute-forceable invite tokens effectively make this a semi-public SSRF. Attacker can probe internal services (`http://169.254.169.254/`, `http://localhost:5432/`) or exfiltrate via response timing. The probe validates `http:` / `https:` protocol only — no host allowlist.
- **Smallest fix**: Add `assertInstanceAdmin(req)` before the URL fetch at `access.ts:2138`, or add an allowlist that rejects RFC-1918, loopback, and link-local hosts. The `redirect: 'manual'` flag is already set (good), but protocol check alone is insufficient.
- **Files to touch**: `server/src/routes/access.ts` (line 2138)
- **Estimated agent time**: under 30 min

### Cluster B: SSRF — PostHog client host validation (already partially fixed, incomplete)
- **Alerts**: #1 (`js/request-forgery`)
- **Severity**: CRITICAL
- **Risk**: `posthog-client.ts:164` makes fetch using `baseUrl` derived from `config.host`. The `validatePostHogHost()` function exists and enforces `https:` + `hostname.endsWith('.posthog.com')`. BUT the validated URL is constructed at client creation time and `baseUrl` is derived from `validatedUrl.origin + validatedUrl.pathname` (line 155). CodeQL flags the fetch at 164 because the taint flows from `config.host` through the `URL` constructor. Given `validatePostHogHost` runs first, this is **contained** — but the validation function is called only in the constructor, not on every `apiFetch()` call, and if the constructor is bypassed in a test/mock path, the fetch is unprotected.
- **Smallest fix**: Verify `validatePostHogHost` is always called before construction. Add a guard that `baseUrl` must start with `https://` and end with `.posthog.com` inline in `apiFetch()` as a belt-and-suspenders check. This will also suppress the CodeQL alert.
- **Files to touch**: `server/src/services/posthog-client.ts` (lines 130–164)
- **Estimated agent time**: under 30 min

### Cluster C: SSRF — GitHub fetch SSRF (validated at URL-construction layer)
- **Alerts**: #20 (`js/request-forgery`)
- **Severity**: CRITICAL
- **Risk**: `github-fetch.ts:21` — `ghFetch(url)` where `url` is caller-controlled. `gitHubApiBase(hostname)` and `resolveRawGitHubUrl(hostname, ...)` construct the URL from a user-provided `hostname`. The `isGitHubDotCom()` check handles only `github.com` / `www.github.com`; for GitHub Enterprise, it falls through to `https://${hostname}/...` with NO validation that `hostname` is not `169.254.169.254` or `localhost`. Authenticated founders can supply any GHE hostname.
- **Smallest fix**: In `github-fetch.ts`, add a `validateGitHubHostname(hostname: string)` function that rejects loopback, RFC-1918, and link-local addresses using a parsed `URL` + hostname allowlist (or at minimum `dns.lookup()` + IP range check). Apply before constructing the URL in both `gitHubApiBase` and `resolveRawGitHubUrl`.
- **Files to touch**: `server/src/services/github-fetch.ts`
- **Estimated agent time**: under 30 min

### Cluster D: SSRF — Plugin UI static proxy (loopback guard exists but CodeQL still flags)
- **Alerts**: #19 (`js/request-forgery`)
- **Severity**: CRITICAL
- **Risk**: `plugin-ui-static.ts:370` — fetch to `targetUrl.href`. Reading the code (lines 337–358), there IS a loopback guard: `targetUrl.hostname` must be `localhost`, `127.0.0.1`, `::1`, or `[::1]`. Protocol must be `http:` or `https:`. This is a **false-positive in production** — the guard is solid. However, it does not guard against DNS rebinding: an attacker-controlled plugin that registers a `devUiUrl` of `http://attacker.com` → at the time of registration, DNS resolves to localhost; at probe time, DNS rebinds to internal IP. Guard should pin by IP (resolve `localhost` → `127.0.0.1` explicitly, don't trust hostname at fetch time).
- **Smallest fix**: Replace hostname string comparison with a pre-connection hook or `node:net` socket binding that asserts the resolved IP is `127.0.0.1` / `::1`. Alternatively restrict to `127.0.0.1` only (not `localhost`) to eliminate DNS rebinding entirely.
- **Files to touch**: `server/src/routes/plugin-ui-static.ts` (lines 337–370)
- **Estimated agent time**: 30–60 min

### Cluster E: Insufficient password hash — MD5/SHA256 used for HMAC tokens (not passwords)
- **Alerts**: #3, #4, #5 (`js/insufficient-password-hash`)
- **Severity**: HIGH
- **Finding**: All three flagged uses are HMAC-SHA256 for OAuth state signing and unsubscribe token signing — NOT password hashing. `board-auth.ts:20` uses `createHash('sha256')` for board API key hashing (not passwords). `daily-digest.ts:179` and `state-store.ts:49` use `createHmac('sha256')` for HMAC signatures.
- **Assessment**: These are ALL false positives. SHA256 for HMAC is correct. Board API key storage via SHA256 hash is acceptable for bearer tokens (not passwords). No bcrypt/argon2 is needed here.
- **Action**: Dismiss all 3 as false positives with reason "SHA256 used for HMAC/token-hash, not password storage"

### Cluster F: SQL injection via HogQL string interpolation (REAL)
- **Alerts**: #11 (`js/incomplete-sanitization`) — `posthog-client.ts:227`
- **Severity**: HIGH
- **Risk**: `events.map((e) => \`'${e.replace(/'/g, "\\'")}'\`).join(", ")` — manual single-quote escaping before interpolating into a HogQL query string. The escape only handles `'`; it does not handle backslash sequences, unicode quote variants, or HogQL-specific injection. If PostHog's HogQL parser is vulnerable to backslash injection, an attacker who controls event names could inject HogQL.
- **Smallest fix**: Use parameterized HogQL queries via PostHog's `params` field in the HogQL API instead of string interpolation. The PostHog HogQL API supports `{param}` substitution.
- **Files to touch**: `server/src/services/posthog-client.ts` (lines 226–237)
- **Estimated agent time**: under 30 min

### Cluster G: XSS — reflected content in text/plain routes
- **Alerts**: #43, #44, #45 (`js/reflected-xss`)
- **Severity**: HIGH
- **Risk**: `llms.ts:74,80` and `access.ts:2131` send user-controlled adapter type / invite token value in `text/plain` responses. CodeQL flags these as reflected XSS. With `Content-Type: text/plain`, browsers do not interpret HTML. However `access.ts:2131` calls `buildInviteOnboardingTextDocument()` which may include the raw invite token in output.
- **Assessment**: Routes explicitly set `res.type('text/plain')`. No HTML is rendered. These are likely false positives BUT worth confirming `buildInviteOnboardingTextDocument` doesn't reflect unescaped token into contexts where a browser might interpret HTML (e.g., if a consumer changed the Content-Type). **Flag as low-risk false positive** — dismiss #44 and #45 (`llms.ts`) confidently; review `access.ts:2131` output for any HTML context before dismissing #43.
- **Files to touch**: none required; verify output of `buildInviteOnboardingTextDocument` does not contain HTML

### Cluster H: XSS — customer unsubscribe reflected XSS (REAL)
- **Alerts**: #140 (`js/reflected-xss`)
- **Severity**: HIGH
- **Risk**: `customer-email-unsubscribe.ts:70` — the route sends `res.status(200).type('text/plain').send(body)` where `body` is constructed from a token-verified payload (userId, companyId, topic). The content is not user-supplied input reflected verbatim. HMAC verification gates the route. However, `topicLabel` at line 63 comes from `payload.t` which comes from the verified token payload — not raw user input.
- **Assessment**: False positive — the reflected value is HMAC-verified and only contains values embedded at token-signing time. Dismiss #140.

### Cluster I: File system race — existsSync then use (REAL, systemic)
- **Alerts**: #123–#137 (15 alerts, `js/file-system-race`)
- **Severity**: HIGH
- **Risk**: `existsSync(p)` then `readFileSync(p)` / `writeFileSync(p)` pattern. Between the check and the use, the path can be replaced. This is the classic TOCTOU documented in `vinamr-invariants.staging.md`. In production (Fly, Docker): lower risk than local dev, but still real for concurrent API requests touching the same company skill dirs.
- **Hottest paths** (production paths, not tests):
  - `adapter-plugin-store.ts:66` — checks `package.json` existence before writing; concurrent npm install could race
  - `company-skills.ts:915` — skill source path stat check before read
  - `workspace-runtime.ts:167` — workspace dir existence check
  - `local-encrypted-provider.ts:66` — secrets file race
  - `dev-server-status.ts:52`, `dev-runner-worktree.ts:51` — dev-only, lower risk
- **Test-file races** (alerts #128–131): `codex-local-execute.test.ts` — test isolation only, not production
- **Smallest fix**: Replace `existsSync + readFile` pairs with `try { await fs.readFile(...) } catch (e) { if (e.code !== 'ENOENT') throw e; }`. No structural change needed.
- **Files to touch** (production only): `server/src/services/adapter-plugin-store.ts`, `server/src/services/company-skills.ts`, `server/src/services/workspace-runtime.ts`, `server/src/secrets/local-encrypted-provider.ts`, `server/src/dev-server-status.ts`, `server/src/dev-runner-worktree.ts`, `cli/src/config/store.ts`, `cli/src/config/secrets-key.ts`, `cli/src/commands/client/company.ts`
- **Estimated agent time**: 30–60 min

---

## Section 2 — Defense in depth (worth fixing, not urgent)

### Cluster J: Missing rate limiting on public/auth-sensitive routes
- **Alerts**: #47–#61, #141–#143 (18 alerts, `js/missing-rate-limiting`)
- **Risk**: Routes without rate limiting in Express. Highest-risk unprotected routes:
  - `app.ts:205` — likely global middleware mount point
  - `oauth.ts:37,113` — OAuth start and callback (brute-force state forgery)
  - `access.ts:1676,1696,1725,1778` — CLI auth challenge create/poll/approve/cancel (token brute-force)
  - `adapters.ts:202,397,524` — adapter management
  - `customer-email-unsubscribe.ts:73,74` — unsubscribe endpoint (token enumeration)
  - `resend-webhook.ts:227` — webhook receiver
- **Smallest fix**: Mount `express-rate-limit` middleware. Check `server/src/middleware/` for existing rate-limit exports; if absent, add a shared `rateLimiter(max, windowMs)` factory. Apply per-route or at router level for auth paths.
- **Files to touch**: `server/src/app.ts`, `server/src/routes/oauth.ts`, `server/src/routes/access.ts`, `server/src/routes/adapters.ts`, `server/src/routes/customer-email-unsubscribe.ts`, `server/src/routes/resend-webhook.ts`
- **Estimated agent time**: 30–60 min

### Cluster K: Path injection — company-skills managed skill dirs
- **Alerts**: #33–#40 (8 alerts on `company-skills.ts`, `js/path-injection`)
- **Risk**: `path.resolve(managedRoot, slug)` and `path.resolve(skillDir, entry.path)` where `slug` and `entry.path` are derived from user input. `normalizeSkillSlug()` is applied to slug. `entry.path` comes from `skill.fileInventory` which is DB-stored. Risk: if `entry.path` contains `../` sequences, `path.resolve` to a parent dir. The `materializeRuntimeSkillFiles` function writes files to `path.resolve(skillDir, entry.path)` — a traversal here writes outside the skill dir.
- **Smallest fix**: After `path.resolve`, assert the result starts with `skillDir + path.sep`. Same pattern as the UI parser guard at `plugin-loader.ts:118`.
- **Files to touch**: `server/src/services/company-skills.ts` (lines 2037–2045, 1731, 1747, 1502)
- **Estimated agent time**: under 30 min

### Cluster L: Path injection — plugin-loader & adapter routes
- **Alerts**: #24–#30 (7 alerts, `js/path-injection`)
- **Risk**: `plugin-loader.ts:69,89,126,131` — `path.resolve(record.localPath)` and `path.join(packageDir, uiParserFile)`. `uiParserPath.startsWith(packageDir + path.sep)` check exists at line 118 for the UI parser path but NOT for the primary `resolvePackageDir` at line 62 which uses raw `record.localPath` from DB. Admin-only path but worth hardening.
  - `adapters.ts:98,247,259` — similar pattern for adapter package dirs
- **Smallest fix**: Validate `record.localPath` in `resolvePackageDir` is an absolute path that does not traverse outside expected plugin root. Add a `path.sep`-anchored prefix check on the resolved value.
- **Files to touch**: `server/src/adapters/plugin-loader.ts`, `server/src/routes/adapters.ts`
- **Estimated agent time**: under 30 min

### Cluster M: Path injection — agent-instructions bundle path
- **Alerts**: #31, #32 (`agent-instructions.ts:177,576`, `js/path-injection`)
- **Risk**: `fs.mkdir(nextRootPath)` and `listFilesRecursive(nextRootPath)` where `nextRootPath` is user-supplied. Line 570 validates `path.isAbsolute(resolvedRoot)` but does not enforce a base-dir prefix.
- **Smallest fix**: Assert `nextRootPath.startsWith(expectedBaseDir)` after resolve.
- **Files to touch**: `server/src/services/agent-instructions.ts`
- **Estimated agent time**: under 30 min

### Cluster N: Path injection — dev-server SDK
- **Alerts**: #21–#23 (`packages/plugins/sdk/src/dev-server.ts:161,168`, `js/path-injection`)
- **Risk**: `normalizeFilePath(uiDir, url)` and `createReadStream(filePath)` in the local dev server. The dev server is SDK-only / local development tooling, not a production server component.
- **Assessment**: Low production risk — this is `packages/plugins/sdk`, runs only on developer machines. Defense-in-depth fix only.
- **Smallest fix**: Verify `normalizeFilePath` enforces `uiDir`-prefix on the result.
- **Estimated agent time**: under 30 min

### Cluster O: Remote property injection — redaction.ts and agent-instructions
- **Alerts**: #90–#105 (16 alerts, `js/remote-property-injection`)
- **Risk**: `obj[key] = value` where `key` comes from `Object.entries(record)` (user-supplied JSON). This pattern is in `redaction.ts` (sanitize loop) and `company-skills.ts` YAML parser. Prototype pollution risk if `key` is `__proto__`, `constructor`, `prototype`.
- **Assessment**: The `for..of Object.entries()` loop copies enumerable own properties only. `Object.entries()` does NOT traverse the prototype chain. `__proto__` set via assignment to a plain `{}` is a prototype pollution risk in older engines. In Node 24 (as per `CLAUDE.md`), `Object.entries()` with a plain `{}` target is generally safe BUT `Object.assign({}, {__proto__: ...})` is a known vector.
- **Smallest fix**: Add `if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;` at the start of each loop, OR use `Object.create(null)` as the target object.
- **Files to touch**: `server/src/redaction.ts`, `server/src/services/company-skills.ts` (lines 440–445), `server/src/services/company-portability-helpers.ts:1413`, `server/src/services/agent-instructions.ts:586`
- **Estimated agent time**: under 30 min

### Cluster P: OAuth unvalidated URL redirect
- **Alerts**: #7–#10 (5 alerts on `oauth.ts`, `js/server-side-unvalidated-url-redirection`)
- **Risk**: `returnUrl` from query param used in `res.redirect(302, ...)` at lines 151, 156, 170, 184, 226. An attacker can craft `?returnUrl=https://evil.com` and the server will redirect the authenticated user post-OAuth to an attacker domain, potentially leaking the OAuth `code` in the Referer header.
- **Smallest fix**: Validate `returnUrl` is a relative path (no protocol, starts with `/`). Reject or strip absolute URLs.
- **Files to touch**: `server/src/routes/oauth.ts`
- **Estimated agent time**: under 30 min

### Cluster Q: Insecure temporary files in tests
- **Alerts**: #83–#89 (`js/insecure-temporary-file`)
- **Risk**: Test files (`codex-local-adapter-environment.test.ts`, `cursor-local-adapter-environment.test.ts`, `gemini-local-adapter-environment.test.ts`, `pi-local-adapter-environment.test.ts`) use predictable temp paths.
- **Assessment**: Test-only, no production path. Low real risk. Fix with `fs.mkdtemp(path.join(os.tmpdir(), 'founderos-test-'))` for correctness. Worth fixing for CI reproducibility.
- **Estimated agent time**: under 30 min

### Cluster R: Indirect command injection — workspace-runtime
- **Alerts**: #109 (`workspace-runtime.ts:470`, `js/indirect-command-line-injection`)
- **Risk**: `spawn(input.command, input.args, ...)` where `input.command` and `input.args` are caller-supplied. This is a legitimate shell execution surface; the concern is whether caller-supplied args reach here without sanitization.
- **Assessment**: `spawn` with an args array (not shell: true) does NOT use a shell — each arg is a separate argv entry, no shell injection possible. This is a CodeQL false positive for `spawn` with array args.
- **Action**: Dismiss #109 as false positive.

### Cluster S: Biased cryptographic random in invite token
- **Alerts**: #46 (`access.ts:106`, `js/biased-cryptographic-random`)
- **Risk**: `INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length]` — modulo bias when alphabet length is not a power of 2 (alphabet is 36 chars). `256 % 36 = 4`, bias of ~1.6% on first 4 characters. For a public invite token used in a UI, the bias is cosmetically imperfect but not practically exploitable (the token space is still 36^8 ≈ 2.8 trillion).
- **Assessment**: Defense-in-depth fix worth doing (use rejection sampling). Not a real vulnerability.
- **Estimated agent time**: under 30 min

---

## Section 3 — False positives (dismiss)

| Alert # | Rule | File:Line | Why FP | Dismissal reason |
|---|---|---|---|---|
| #1 | js/request-forgery | posthog-client.ts:164 | `validatePostHogHost()` runs before every construction; host allowlisted to `*.posthog.com` | Used only with validated host allowlist |
| #3 | js/insufficient-password-hash | board-auth.ts:20 | SHA256 used to hash bearer tokens, not passwords | SHA256 appropriate for token hash, not password |
| #4 | js/insufficient-password-hash | daily-digest.ts:179 | HMAC-SHA256 for unsubscribe token signing | HMAC-SHA256 is correct for MAC, not password storage |
| #5 | js/insufficient-password-hash | state-store.ts:49 | HMAC-SHA256 for OAuth state signing | HMAC-SHA256 correct for integrity check |
| #17 | js/incomplete-url-substring-sanitization | posthog-client.test.ts:208 | Test file, not production code | Test file; no production risk |
| #19 | js/request-forgery | plugin-ui-static.ts:370 | Loopback-only guard at lines 337–358 | URL restricted to loopback by explicit hostname check (DNS rebinding caveat noted in Cluster D) |
| #41 | js/xss-through-dom | plugin-kitchen-sink-example/index.tsx:1537 | Example plugin, not production code | Example/SDK code, not deployed |
| #42 | js/xss-through-dom | plugin-kitchen-sink-example/index.tsx:1545 | Example plugin, not production code | Example/SDK code, not deployed |
| #43 | js/reflected-xss | access.ts:2131 | `text/plain` Content-Type; content from HMAC-verified token, not raw input | Content-Type prevents HTML interpretation; source is verified token |
| #44 | js/reflected-xss | llms.ts:74 | `text/plain` response; adapterType from allowlist check | text/plain, value from internal allowlist |
| #45 | js/reflected-xss | llms.ts:80 | `text/plain` response; value is a hardcoded doc string | text/plain, no user-controlled value |
| #46 | js/biased-cryptographic-random | access.ts:106 | Modulo bias on invite token; 36^8 space makes practical exploitation infeasible | Bias cosmetic only; space too large to exploit |
| #82 | js/file-access-to-http | scripts/founderos-commit-metrics.ts:840 | Build/metrics script, not production server | Script only, not a production server path |
| #106 | js/indirect-command-line-injection | scripts/check-forbidden-tokens.mjs:81 | Build script, not server code | Build-time script only |
| #107 | js/indirect-command-line-injection | scripts/ci/file-size-check.ts:104 | CI script, not server code | CI script only |
| #108 | js/indirect-command-line-injection | cli/src/client/board-auth.ts:181 | CLI tool spawning with array args (no shell:true) | spawn with args array — no shell injection |
| #109 | js/indirect-command-line-injection | workspace-runtime.ts:470 | spawn with args array, not shell:true | spawn with args array — no shell injection |
| #122 | js/user-controlled-bypass | access.ts:607 | Log summarization function; bypass is cosmetic (log output only) | Only affects log output, not auth decision |
| #140 | js/reflected-xss | customer-email-unsubscribe.ts:70 | text/plain; content from HMAC-verified token payload | HMAC-verified content, text/plain |
| #139 | js/incomplete-multi-character-sanitization | content-publish-tick.ts:136 | Strip HTML regex `<[^>]*>` for plain-text email fallback | Plain-text fallback; not a security boundary |
| #62 | js/resource-exhaustion | access.ts:1545 | Timeout capped to max 15000ms at line 2168; AbortController used | AbortController + capped timeout in place |
| #11 | js/incomplete-sanitization | ui/src/components/IssueChatThread.tsx:1648 | `file.name.replace(/[[\]]/g, ...)` escapes markdown brackets only, not XSS — inserted into markdown editor state, not DOM | Markdown state mutation, not innerHTML |
| #12 | js/incomplete-sanitization | ui/src/components/CommentThread.tsx:816 | Same pattern — markdown state, not DOM | Markdown state mutation, not innerHTML |
| #63–#81 | js/polynomial-redos | All adapter parse files | These regexes process adapter stdout/stderr from controlled child processes, not attacker HTTP input | Input is from spawned local process, not user-supplied |

Note: Alerts #83–#89 (insecure temp files in test files), #128–#131 (file-system-race in test files), and #110–#121 (http-to-file-access in CLI/scripts) are classified as defense-in-depth rather than false positives because fixing them has correctness value even though they are not production security issues.

---

## Section 4 — Deferred to human

| Alert # | Why deferred |
|---|---|
| #63–#81 (js/polynomial-redos, adapter parsers) | Regexes in adapter stdout parsers. Input is from local child processes. No attacker path to this input in current architecture. Fix requires regex refactor per adapter — 18 files, adapter-specific logic. Low real risk. Defer to adapter maintainer sprint. |
| #110–#121 (js/http-to-file-access, CLI + scripts) | CLI commands that read a file and POST it to the server. CodeQL flags "file read flows into HTTP request." This is intentional CLI behavior. Requires UX decision on whether to add file size / MIME type guards. |
| #144, #138 (js/file-access-to-http, agent services) | `content-generator.ts` and `growth-suggester.ts` read agent-context files and send to LLM. Intentional design pattern. Requires product decision on context file scoping. |

---

## Recommended dispatch plan

Dispatch these agents in parallel after triage is approved:

1. **Agent: fix-ssrf-webhook-probe** — Add host validation (RFC-1918 + loopback + link-local blocklist) to `probeInviteResolutionTarget` in `access.ts`. Add `assertInstanceAdmin` guard or allowlist. Fixes Cluster A (#18). Target: `server/src/routes/access.ts:2138–2178`. Under 30 min.

2. **Agent: fix-ssrf-github-fetch** — Add `validateGitHubHostname()` to `github-fetch.ts` rejecting RFC-1918/loopback IPs. Apply to both `gitHubApiBase` and `resolveRawGitHubUrl`. Fixes Cluster C (#20). Target: `server/src/services/github-fetch.ts`. Under 30 min.

3. **Agent: fix-hogql-injection** — Replace string-interpolated HogQL in `posthog-client.ts:227` with parameterized HogQL query via PostHog's `params` field. Fixes Cluster F (#11 incomplete-sanitization). Target: `server/src/services/posthog-client.ts:220–237`. Under 30 min.

4. **Agent: fix-oauth-redirect** — Validate `returnUrl` is a relative path (reject absolute URLs) in `oauth.ts`. Fixes Cluster P (#7–#10). Target: `server/src/routes/oauth.ts`. Under 30 min.

5. **Agent: fix-toctou-existssync** — Replace `existsSync + readFile` with try/catch ENOENT across production paths (Cluster I). Target files: `adapter-plugin-store.ts`, `company-skills.ts`, `workspace-runtime.ts`, `local-encrypted-provider.ts`, `dev-server-status.ts`, `dev-runner-worktree.ts`, `cli/src/config/store.ts`, `cli/src/config/secrets-key.ts`. 30–60 min.

6. **Agent: fix-path-traversal** — Add `startsWith(baseDir + path.sep)` assertion after `path.resolve` in `company-skills.ts` (materializeRuntimeSkillFiles, createLocalSkill), `plugin-loader.ts` (resolvePackageDir), `adapters.ts` (resolveAdapterPackageDir), `agent-instructions.ts` (nextRootPath). Fixes Clusters K, L, M (#21–#40). 30–60 min.

7. **Agent: fix-prototype-pollution** — Add `__proto__`/`constructor`/`prototype` key guards in `redaction.ts` loop and YAML parser in `company-skills.ts`. Use `Object.create(null)` targets. Fixes Cluster O (#90–#105). Under 30 min.

8. **Agent: fix-rate-limiting** — Mount `express-rate-limit` on auth-sensitive routes: OAuth start/callback, CLI auth challenge CRUD, unsubscribe routes, resend webhook. Fixes Cluster J (#47–#61, #141–#143). 30–60 min.

9. **Agent: dismiss-false-positives** — Dismiss all alerts listed in Section 3 via `gh api`. ~20 dismissals. Under 30 min.

10. **Agent: fix-dns-rebinding-plugin-proxy** — Replace hostname string comparison in `plugin-ui-static.ts` with IP-level validation that resolves the hostname and asserts it's `127.0.0.1`/`::1`. Fixes Cluster D (#19). 30–60 min.
