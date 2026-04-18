# FounderOS Dogfooding Playbook

The 24-hour customer-simulation smoke before you let anyone pay for this.

This runbook walks through every capability a real customer will hit — spawn
a company, configure providers, wake agents, check costs, export + re-import.
Anything that breaks here is a bug you'd rather find yourself.

Run this against a **throwaway** deployment. It will create real rows and
(if you've set real API keys) spend real tokens. Budget ~$5 in model spend.

---

## Preflight (5 minutes)

```bash
# 1. Fresh Fly app
./scripts/fly-provision.sh dogfood-$(date +%Y%m%d) \
  --db-url "postgresql://postgres:...@host:5432/postgres" \
  --region bom

# 2. Wait for health
URL="https://founderos-dogfood-$(date +%Y%m%d).fly.dev"
until curl -sf "$URL/api/healthz" > /dev/null; do sleep 5; done

# 3. Automated smoke (verifies 6 core paths)
./scripts/fly-smoke.sh "$URL"
```

Stop here if smoke fails. Fix, redeploy, repeat.

---

## Part 1 — First-run experience (15 min)

Goal: what does a brand-new user see?

1. Open the URL in a browser you aren't signed into.
2. If Clerk is active → confirm the `<SignIn>` card renders with the
   FounderOS brand panel on the right.
3. Sign up with a throwaway email.
4. You should land on the **Dashboard** with the **OnboardingWizardNew**
   (welcome → template → providers → review).
5. Click **Get started** → template picker shows 3 templates.
6. Pick **Solo Indie SaaS Founder**.
7. Providers step:
   - If this deployment has no provider keys, confirm the "add key" links
     appear and the **Continue** button is disabled.
   - Paste a real Anthropic key (or rely on detected Claude CLI). Page
     should auto-refresh within 5s and unblock Continue.
8. Review step: change the company name, confirm stats (6 agents / 3 goals
   / 3 projects), click **Launch**.
9. You land on the new Dashboard with the company already selected. You
   should see:
   - Company Pulse widget with placeholder metrics
   - Company Providers widget showing "6× Claude"
   - Active agents panel
   - Metric cards (agents / tasks / spend / activity)

**Failure modes to log:**
- Provider detection stuck — check `/api/providers` response.
- Spawn returns error — check server logs for migration / key issues.
- Dashboard missing data — check `/api/companies/:id/dashboard` endpoint.

---

## Part 2 — Provider configuration (10 min)

1. Navigate to **Instance Settings → AI Providers**.
2. For each of Claude / OpenAI / Gemini:
   - Confirm correct "detected" status reflects env + CLI reality.
   - Click **Paste API key**, enter a 32+ char string, click **Save**.
   - Verify the stored-key row appears with a hint like `…wxyz` + updated timestamp.
   - Click **Remove** — verify row disappears.
3. Set back whichever key you actually intend to use for the next stages.

**Check:** after setting a key, `/api/providers` must show `availability.<family>.api = true` and the `storedKeys` array must contain the family.

---

## Part 3 — Agent operations (45 min)

1. Navigate to **Agents**. Confirm you see 6 agents with provider badges (logo + model + CLI/API icon).
2. Click the **Claude** provider-family chip. Confirm list filters to 6 agents.
3. Click **All** to clear.
4. Click any agent → **Agent Detail**.
5. Trigger a wakeup:
   ```bash
   curl -sb cookies.txt -X POST \
     "$URL/api/agents/<agent-id>/wakeup" \
     -H "content-type: application/json" \
     -d '{"triggerDetail":"manual"}'
   ```
6. Watch the `/api/heartbeat-runs/<run-id>` endpoint every few seconds until
   `status` flips to `completed` or `failed`.
7. If it fails with "Invalid API key", your key isn't flowing into process.env —
   confirm on the server: `env | grep -E "ANTHROPIC|OPENAI|GEMINI"`.
8. If it fails with "Process adapter missing command", the CLI isn't on PATH.
   Ship agents must use `claude_api` / `openai_api` adapters when CLI
   isn't available.

**Success looks like:** 1-3 completed runs, stdout contains a final
`{"type":"result","subtype":"success", …}` JSON block with `total_cost_usd`
populated.

---

## Part 4 — Cost visibility (10 min)

1. Wait ~10 minutes after wakeups (for cost_events to accumulate).
2. Back on Dashboard, confirm the **Company Providers** widget now shows
   a non-zero dollar amount under the provider family you ran.
3. Navigate to **Costs** (in the sidebar) — confirm run-level detail.
4. Hit `/api/companies/:id/providers-overview` directly:
   ```bash
   curl -sb cookies.txt "$URL/api/companies/<id>/providers-overview" | jq
   ```

Should show `monthSpendByFamily.anthropic > 0` (or whichever).

---

## Part 5 — Template export + import (15 min)

1. Company Settings → **Export as template**. Browser downloads a JSON file.
2. Inspect it:
   ```bash
   jq '. | {id, name, agents: (.agents | length), goals: (.goals | length)}' dogfood.template.json
   ```
3. All keys should be kebab-case, prefixes should be 3 uppercase chars, and
   every `reports_to` / `ownerKey` / `leadKey` / `assigneeKey` should resolve
   to an `agent.key` / `goal.key` / `project.key` inside the same file.
4. Run the spawn API against the exported JSON (conceptually — the current
   API accepts a templateId, not an inline template; extend if needed, or
   drop the JSON into `packages/templates/src/custom/` and restart).

---

## Part 6 — Chaos (15 min)

Break things on purpose, verify they fail gracefully.

1. **Kill the DB** (pause the Supabase project from the dashboard).
2. `curl $URL/api/healthz` → still `200 ok` (liveness unaffected).
3. `curl $URL/api/readyz` → `503 db unreachable`.
4. `curl $URL/api/companies` → 500 with a clean JSON error body.
5. Un-pause the DB → readiness returns to 200 within 30s.

1. **Revoke the Anthropic key** mid-run.
2. Next heartbeat fails with an adapter error.
3. Confirm the failure surfaces in the run log and the agent isn't
   silently re-scheduled into a loop.

---

## Part 7 — Shutdown (5 min)

1. Revoke all dogfood API keys at the provider dashboards (don't leak!).
2. `fly apps destroy founderos-dogfood-YYYYMMDD` (or suspend if you want
   to re-test later).

---

## Pass criteria

All of the following must hold for the dogfood to be a pass:

- [ ] Smoke script exits 0
- [ ] Template spawn completes in < 5 seconds
- [ ] At least 2 agent wakeups succeed end-to-end
- [ ] Provider widget shows non-zero spend after a wakeup
- [ ] Template export round-trips through `jq` without errors
- [ ] Liveness probe stays green through the DB outage test
- [ ] No secrets leak in server logs (grep for `sk-ant-`, `sk-proj-`)

If any fail, **do not** open the door to real customers. File issues, fix,
rerun the whole playbook (not just the broken step).

---

## Known gaps (not blockers)

- Billing: Stripe wiring is not shipped; customers pay for hosting via
  manual invoice for now.
- Multi-tenant: this is single-tenant only. Each customer gets their own
  Fly app.
- Clerk UserButton sign-out: only better-auth path has a clean sign-out
  UX. Clerk users can sign out via Clerk's own menu.
