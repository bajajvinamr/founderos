# Manual Click-Through QA (5 minutes)

Quick pre-release sanity pass. Run this on localhost or Vercel preview before merging to main.

**URLs to test:**
- Local: `http://localhost:3100` (or `:5173` for frontend-only)
- Production: `https://founderos.fly.dev` (after deploy)

---

## 1. Dashboard (30 seconds)

**URL:** `http://localhost:3100/`

- [ ] Page loads (no 502 / 500 error)
- [ ] Header visible with logo and nav
- [ ] Main content area renders (cards, stats, or empty state)
- [ ] No red errors in browser console (F12)

**KNOWN ISSUE:** If you see 500 on `/`, check `.env` for missing `NEXT_PUBLIC_*` vars.

---

## 2. Decisions Tab (30 seconds)

**URL:** `http://localhost:3100/decisions`

- [ ] Tab or nav link is clickable
- [ ] Decision list loads (cards, table, or empty state)
- [ ] No console errors
- [ ] Click one decision card (if any exist) → detail page loads

**KNOWN ISSUE:** 404 on `/decisions` = routing prefix missing. Check `server/src/app.ts` for prefix mounting.

---

## 3. Departments (30 seconds)

**URL:** `http://localhost:3100/departments`

- [ ] Departments list loads
- [ ] Click "Chief of Staff" or any dept → detail page loads (not blank, not 404)
- [ ] Department name visible in header

**KNOWN ISSUE:** 500 on `/departments/chief-of-staff` = case mismatch or route prefix bug. Exact error in Sentry.

---

## 4. Weekly View (30 seconds)

**URL:** `http://localhost:3100/weekly`

- [ ] Page loads
- [ ] Calendar or agenda grid renders
- [ ] Can see days/weeks (visual structure exists)

**KNOWN ISSUE:** Blank page = missing `/api/agenda` endpoint or auth middleware blocking request.

---

## 5. Conversations (30 seconds)

**URL:** `http://localhost:3100/conversations`

- [ ] Thread list or conversation UI loads
- [ ] Click a thread (if any exist) → detail/compose view loads
- [ ] No console errors

**KNOWN ISSUE:** 404 or 500 = route prefix or service not wired. Check logs.

---

## 6. Agents & Services (30 seconds)

**URL:** `http://localhost:3100/agents` or `http://localhost:3100/hire`

- [ ] Page loads (either agents list or hiring flow)
- [ ] List of registered agents visible (cards, table, or list)
- [ ] Click an agent card (if clickable) → detail or action modal loads

**KNOWN ISSUE:** 404 on `/hire` = endpoint not mounted. Check `deploy.md` for recent URL changes.

---

## 7. Goals (30 seconds)

**URL:** `http://localhost:3100/goals`

- [ ] Goals page loads
- [ ] Goal list or creation form visible
- [ ] Can see goal entries or "Create Goal" button
- [ ] No console errors

---

## 8. Audit Log (30 seconds)

**URL:** `http://localhost:3100/audit`

- [ ] Audit log list loads (events table or stream)
- [ ] Try a filter (if available) → results update
- [ ] Timestamps or event types visible

---

## 9. Settings (Optional, 30 seconds)

**URL:** `http://localhost:3100/settings` or gear icon in header

- [ ] Settings page loads (forms, toggles, tabs)
- [ ] No console errors
- [ ] Can navigate back to dashboard

---

## 10. API Health Check (10 seconds)

**Terminal:**

```bash
curl -s http://localhost:3100/api/health/deep | jq .
```

- [ ] Response includes `"status": "ok"`
- [ ] All checks have latency < 1000ms
- [ ] No "fail" status on critical checks (db_roundtrip, table_check)

**Expected output:**
```json
{
  "status": "ok",
  "checks": [
    { "name": "db_roundtrip", "status": "ok", "latencyMs": 45 },
    { "name": "table_check", "status": "ok", "latencyMs": 12 },
    { "name": "session_resolver", "status": "ok", "latencyMs": 1 },
    ...
  ],
  "version": "23D"
}
```

---

## 11. Create Handoff (1 minute, if applicable)

**Terminal:**

```bash
COMPANY_ID="YOUR_COMPANY_UUID_HERE"
curl -X POST "http://localhost:3100/api/companies/$COMPANY_ID/handoffs" \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{
    "title": "QA Test Handoff",
    "description": "Verify handoff creation works",
    "departmentId": "dept-uuid"
  }'
```

- [ ] Response is 201 Created (not 400 / 500)
- [ ] Returned handoff object has `id`, `title`, `createdAt`
- [ ] Go to UI and reload → new handoff appears in appropriate view

**Note:** You may need a valid session cookie and company/department IDs from the running instance.

---

## Summary

**All green?** Ready to promote dev → main. Deploy will run full smoke tests + deep health check.

**Any red?** Stop, investigate in logs/Sentry, fix, and re-run this checklist.
