#!/bin/bash
echo "======================================"
echo " FounderOS · status dashboard"
echo " $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo
echo "── URLs ────────────────────────────────"
DEMO=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/demo-tunnel.log 2>/dev/null | head -1)
echo "Demo tunnel (interview):  ${DEMO:-NOT RUNNING}"
echo "Prod UI:                  https://founderos-bice.vercel.app"
echo "Prod backend (Fly):       https://founderos.fly.dev"
echo
echo "── Health checks ───────────────────────"
for name in "demo:$DEMO" "prod:https://founderos-bice.vercel.app" "fly:https://founderos.fly.dev"; do
  n="${name%%:*}"
  u="${name#*:}"
  [ -z "$u" ] && { printf "%-10s %s\n" "$n" "skip"; continue; }
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$u/api/health" 2>/dev/null || echo "---")
  printf "%-10s %s  %s/api/health\n" "$n" "$code" "$u"
done
echo
echo "── Local processes ─────────────────────"
printf "postgres (54329): %s\n" "$(lsof -iTCP:54329 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1,$2; exit}' || echo down)"
printf "founderos (3100): %s\n" "$(lsof -iTCP:3100 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1,$2; exit}' || echo down)"
printf "tunnels:          %s\n" "$(pgrep -l cloudflared 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "── Demo data (local PG) ────────────────"
node - <<'NODE'
import pg from "/Users/vinamr/Projects/founderos/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js";
const c = new pg.Client({ host:"127.0.0.1", port:54329, user:"founderos", password:"founderos", database:"founderos" });
try {
  await c.connect();
  const tables = ["companies","agents","approvals","company_memory","integrations","integration_data","activity_log","heartbeat_runs","issues","goals","weekly_wraps","conversations","decision_outcomes"];
  for (const t of tables) {
    try { const r = await c.query(`SELECT COUNT(*)::int FROM ${t}`); console.log(`${t.padEnd(22)} ${r.rows[0].count}`); }
    catch { console.log(`${t.padEnd(22)} n/a`); }
  }
  const names = await c.query(`SELECT name FROM companies ORDER BY created_at`);
  console.log(`companies: ${names.rows.map(r=>r.name).join(", ")}`);
  await c.end();
} catch (e) { console.log("DB unreachable: " + e.message); }
NODE
echo
echo "── Recent shipped waves ────────────────"
cd /Users/vinamr/Projects/founderos 2>/dev/null && git log --oneline -8
echo
echo "── Open tasks ──────────────────────────"
echo "19A: Agent-to-agent handoffs  — queued for 4pm London sub quota reset"
echo
echo "── User-action required ────────────────"
echo "• Stripe live keys          (scaffold ready)"
echo "• Sentry DSN                (monitoring wired, DSN pending)"
echo "• Resend paid upgrade       (~\$20/mo at 30-50 users)"
echo "======================================"
