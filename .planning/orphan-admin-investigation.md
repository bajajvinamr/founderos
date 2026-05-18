# FounderOS — Orphan `instance_admin` Row Investigation

_Generated 2026-05-16. Read-only investigation for /council review. No SQL was executed._

---

## TL;DR — Issue Is Already Resolved

**GitHub issue #66 ("founder-action: DELETE single instance_admin orphan row 785119d5…") was closed 2026-05-07 as resolved without action.**

A dream-state cycle on 2026-05-07 ran the preflight SELECT against prod Managed Postgres (`gjpkdonynwy0yln4`, database `fly-db`) and found zero rows matching the 785119d5 prefix AND zero total orphans. The table was empty. The structural fix (migration `0073_auth_mirror_orphan_guard.sql`, FK + `ON DELETE CASCADE`, INNER JOIN in `runPostSignupBootstrap`) had already cleaned the orphan — either via the migration's own `DELETE` statement during a `fly deploy` release command, or during a prior session.

**The Vanta:ship hook nudge firing since 2026-05-04 is stale.** The ledger was never marked synced. The action is done; the hook needs to be reconciled, not re-executed.

---

## 1. Schema — `instance_user_roles`

**File:** `packages/db/src/schema/instance_user_roles.ts` (lines 1–24)

```
Table: public.instance_user_roles
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid()
  user_id     text         NOT NULL
  role        text         NOT NULL DEFAULT 'instance_admin'
  created_at  timestamptz  NOT NULL DEFAULT now()
  updated_at  timestamptz  NOT NULL DEFAULT now()

Unique index: instance_user_roles_user_role_unique_idx  ON (user_id, role)
Index:        instance_user_roles_role_idx               ON (role)
FK (post-2026-05-04 fix): instance_user_roles_user_id_user_id_fk
    FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE
```

**Migration history:**
- `0014_many_mikhail_rasputin.sql` (lines 58–64): original table creation — NO FK on `user_id`, only the `(user_id, role)` unique index.
- `0073_auth_mirror_orphan_guard.sql` (full file): structural fix — `DELETE` orphans, then `ALTER TABLE ADD CONSTRAINT … ON DELETE CASCADE`.

**Root FK gap (pre-fix):** The original `0014` migration created `instance_user_roles.user_id` as plain `text NOT NULL` with no FK constraint. Deleting or never-mirroring a user left an unreachable row permanently — no cascade, no referential error.

---

## 2. First-User-Wins Promotion Logic

**File:** `server/src/auth/post-signup-hook.ts` (lines 133–199)

The promotion logic lives inside `runPostSignupBootstrap`. Specifically, the "count existing human admins" query that gates promotion is at lines 162–173:

```typescript
const existingHumanAdmin = await tx
  .select({ userId: instanceUserRoles.userId })
  .from(instanceUserRoles)
  .innerJoin(authUsers, eq(instanceUserRoles.userId, authUsers.id))  // ← INNER JOIN, post-fix
  .where(
    and(
      eq(instanceUserRoles.role, "instance_admin"),
      ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),             // ← excludes "local-board"
    ),
  )
  .limit(1)
  .then((rows) => rows[0] ?? null);
```

**The pre-fix bug (committed comment at line 156–161):** The original code used a bare `select().from(instanceUserRoles)` with no JOIN — any orphan `instance_user_roles` row (user deleted from `public."user"`, never mirrored, or from Supabase auth that never landed in the app DB) counted as "a real admin exists" and blocked all subsequent first-user-wins promotion. One orphan row = permanent gate closure.

**The fix:** `INNER JOIN authUsers` ensures only role rows with a live matching `public."user"` entry count. An orphan row (no matching user) is excluded from the join result and does not block promotion.

**The advisory lock serialization (lines 135–153):** `pg_advisory_xact_lock(7234890)` is acquired inside a transaction to prevent two concurrent first-signups both observing zero admins and both promoting. The lock auto-releases on COMMIT/ROLLBACK. This is the P1 council fix from 2026-05-03.

---

## 3. Insertion Sites Catalog

| Site | File:Line | Trigger | Notes |
|------|-----------|---------|-------|
| Local-board seeding | `server/src/index.ts:269` | Server startup in `local_trusted` mode | Inserts synthetic `LOCAL_BOARD_USER_ID` row; idempotent read-first |
| Board-claim (first real founder) | `server/src/board-claim.ts:99` | `/board-claim/:token` route; founder claims the board | Inserts real user; also DELETEs the local-board row (line 107) |
| First-user-wins bootstrap | `server/src/auth/post-signup-hook.ts:188` | First authenticated request via `maybeBootstrapNewUser` → `runPostSignupBootstrap` | Lock-serialized, INNER JOIN guard, `onConflictDoNothing` |
| Admin promote via access route | `server/src/services/access.ts:150` | `promoteInstanceAdmin()` — admin-facing UI action | Read-first-then-insert, not TOCTOU-safe (non-bootstrap path, low-concurrency) |
| Invite consume | `server/src/services/instance-invite.ts:205` | `consumeInvite()` when invite role = `instance_admin` | `onConflictDoNothing` on `(userId, role)` |

**How the 785119d5 orphan was created:**

The pre-fix flow (prior to `0073_auth_mirror_orphan_guard.sql`):
1. FounderOS deployed in `authenticated` mode with Supabase as the identity provider.
2. A user signed up → Supabase created a row in `auth.users` with ID `785119d5-…`.
3. `runPostSignupBootstrap` ran (an earlier version) and promoted the user to `instance_admin` in `instance_user_roles`.
4. The user was then deleted from Supabase `auth.users` (or from `public."user"` directly, or the mirror upsert never ran pre-fix so `public."user"` was never populated).
5. No `ON DELETE CASCADE` existed → the `instance_user_roles` row remained.
6. Every subsequent signup saw `COUNT(*) > 0` in the (then-JOIN-less) check and was refused promotion.

**The "email-squatting" issue** (documented in `server/src/routes/auth-webhook.ts:1–28`): The original Supabase `user.created` webhook fired BEFORE email confirmation and triggered bootstrap. An unconfirmed user's signup created an orphan if they never confirmed. Post-fix: bootstrap is deferred to the first authenticated request (`maybeBootstrapNewUser` in `middleware/auth.ts:66–90`), which only fires after Supabase has issued a valid JWT (i.e., after email confirmation or OAuth).

---

## 4. Production DB Connection Pattern

From `CLAUDE.md`:
- App: `founderos` (Fly.io, region `lhr`)
- Managed Postgres app: `gjpkdonynwy0yln4`
- Connection: `fly pg connect -a gjpkdonynwy0yln4` (requires Fly CLI + `FLY_API_TOKEN`)
- `DATABASE_URL` is a Fly secret; not in repo

**Safe read-only investigation path (no local prod access needed):**

```bash
fly pg connect -a gjpkdonynwy0yln4
# psql prompt inside Fly Managed Postgres
```

All queries below are SELECT-only. No modification is needed because the issue is already resolved.

---

## 5. Proposed DELETE Statement (Historical — No Longer Needed)

The following is documented for completeness and for the /council brief. **Do not execute — the row was already removed.**

### Pre-DELETE verification query

```sql
-- Step 1: confirm the targeted orphan exists and is genuinely orphaned
SELECT
    iur.user_id,
    iur.role,
    iur.created_at,
    u.id IS NULL AS is_orphan
FROM instance_user_roles iur
LEFT JOIN public."user" u ON u.id = iur.user_id
WHERE iur.user_id::text LIKE '785119d5%'
  AND iur.role = 'instance_admin';
-- Expected when orphan exists: 1 row, is_orphan = true
-- Actual (as of 2026-05-07): 0 rows
```

```sql
-- Step 2: broader orphan scan (any role, any user_id)
SELECT iur.user_id, iur.role, iur.created_at
FROM instance_user_roles iur
LEFT JOIN public."user" u ON u.id = iur.user_id
WHERE u.id IS NULL
  AND iur.user_id <> 'local-board';
-- Expected when clean: 0 rows
-- Actual (as of 2026-05-07): 0 rows
```

### DELETE (within a transaction, idempotent)

```sql
BEGIN;

-- Safety: verify before deleting
SELECT iur.user_id, iur.role, iur.created_at, u.id IS NULL AS is_orphan
FROM instance_user_roles iur
LEFT JOIN public."user" u ON u.id = iur.user_id
WHERE iur.user_id::text LIKE '785119d5%'
  AND iur.role = 'instance_admin';
-- If 0 rows returned: ROLLBACK — nothing to do.
-- If 1 row with is_orphan = true: continue.

-- The targeted DELETE
DELETE FROM instance_user_roles
WHERE user_id::text LIKE '785119d5%'
  AND role = 'instance_admin'
  AND NOT EXISTS (
    SELECT 1 FROM public."user" u WHERE u.id = instance_user_roles.user_id
  );
-- NOT EXISTS guard: defense-in-depth — only deletes actual orphans.
-- LIKE prefix is safe here: a partial UUID prefix with 8 hex chars has
-- astronomically low collision probability. Exact match preferred if full
-- UUID is supplied.

-- Verify: exactly 0 orphans remain
SELECT COUNT(*) AS orphan_count
FROM instance_user_roles iur
LEFT JOIN public."user" u ON u.id = iur.user_id
WHERE u.id IS NULL
  AND iur.user_id <> 'local-board';
-- Expect: 0

-- Only COMMIT when orphan_count = 0 and DELETE returned 1 row affected.
-- Otherwise: ROLLBACK.
COMMIT;
```

### Post-DELETE verification

```sql
-- Sanity: table state after fix
SELECT COUNT(*) AS total_rows FROM instance_user_roles;
SELECT COUNT(*) AS admin_rows FROM instance_user_roles WHERE role = 'instance_admin';
SELECT iur.user_id, iur.role, u.email
FROM instance_user_roles iur
JOIN public."user" u ON u.id = iur.user_id;
-- All rows should have a corresponding public."user" entry.
```

---

## 6. Deeper Fix — Already Shipped (Migration 0073)

**File:** `packages/db/src/migrations/0073_auth_mirror_orphan_guard.sql`

The structural fix is already in production. It consists of two parts:

```sql
-- Part 1: one-time DELETE of pre-existing orphans (ran during fly deploy release command)
DELETE FROM "instance_user_roles"
WHERE "user_id" <> 'local-board'
  AND NOT EXISTS (
    SELECT 1 FROM "public"."user" u WHERE u.id = "instance_user_roles"."user_id"
  );

-- Part 2: FK constraint preventing future orphans
ALTER TABLE "instance_user_roles"
  ADD CONSTRAINT "instance_user_roles_user_id_user_id_fk"
  FOREIGN KEY ("user_id")
  REFERENCES "public"."user"("id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;
```

**Constraint name:** `instance_user_roles_user_id_user_id_fk`
**Effect:** deleting a row from `public."user"` now cascades automatically to `instance_user_roles`. The orphan failure mode cannot recur for any user whose row exists in `public."user"`.

**Belt-and-suspenders:** Even if the FK is somehow bypassed (raw SQL, Supabase direct auth deletion without app-layer mirror), the INNER JOIN in `runPostSignupBootstrap` (line 165) acts as a second guard — orphan rows are invisible to the admin count query.

**The `public."user"` mirror upsert** (`server/src/auth/post-signup-hook.ts:64–86`) ensures every authenticated user lands in `public."user"` before any role grant. Bootstrap order is now: mirror upsert → advisory lock → admin count via INNER JOIN → conditional promote. The Supabase `auth.users` / Fly Postgres `public."user"` split is documented in `CLAUDE.md` ("Two-database split" bullet).

---

## 7. GitHub Issue and PR Tracking

- **Issue #66** — "founder-action: DELETE single instance_admin orphan row 785119d5… in production Postgres"
  - State: **CLOSED** (2026-05-07T09:11:08Z)
  - Resolution: zero rows found on preflight SELECT; closed without action.
  - Comment records the exact SQL run and the prod state at close time.

- The structural fix (`0073_auth_mirror_orphan_guard.sql` + `post-signup-hook.ts` INNER JOIN + advisory lock) was merged as part of the 2026-05-04 council remediation sprint. No dedicated PR number recovered from this read-only investigation, but the migration file comment ("Council 2026-05-04") and schema comment in `instance_user_roles.ts` (lines 8–11) cite the same date.

---

## 8. Risk Analysis

### Blast radius of the DELETE (if it had been needed)

- **Rows affected:** exactly 1 (the 785119d5 orphan)
- **Cascade:** none — the user no longer existed in `public."user"`, so no company memberships, sessions, or other FK-linked rows would have been cascade-deleted. The orphan was the terminal node.
- **Effect on active sessions:** none — the user associated with the orphan user_id was already gone (or never existed in the app DB). No one was actively logged in under that identity.
- **Effect on onboarding:** positive — removing the orphan restores first-user-wins promotion for the next real signup.
- **Irreversibility:** medium. The row, once deleted, cannot be restored without re-inserting it. However, the user's absence from `public."user"` means the row was already non-functional — restoring it would recreate the blockage.

### What could go wrong (historical, for /council context)

| Risk | Mitigation |
|------|-----------|
| DELETE hits the wrong row (partial UUID collision) | `NOT EXISTS` guard + `AND role = 'instance_admin'` narrow the predicate; 8-char hex prefix collision probability is ~1 in 4 billion |
| Delete removes a live user's admin row | `LEFT JOIN … WHERE u.id IS NULL` ensures only true orphans are targeted |
| Post-delete: table is empty and next signup races | The advisory lock in `runPostSignupBootstrap` serializes concurrent first-signups; idempotent `onConflictDoNothing` handles retries |
| FK constraint added on non-empty table fails | Migration order: DELETE orphans first, then ADD CONSTRAINT — validated in `0073` |

### Rollback plan (if DELETE had been executed)

```sql
-- If the DELETE was run but you discover a live user was affected:
-- 1. Identify the real user in public."user"
SELECT id, email FROM public."user" WHERE id::text LIKE '785119d5%';
-- 2. Re-insert their role
INSERT INTO instance_user_roles (user_id, role)
VALUES ('<full-uuid>', 'instance_admin')
ON CONFLICT (user_id, role) DO NOTHING;
```

---

## 9. Open Questions for /council

1. **Stale Vanta:ship hook:** The hook has been nudging since 2026-05-04 about an action that was verified-complete 2026-05-07 and logged in the sync queue as `synced: false`. How should stale sync-queue entries be reconciled? Should the auto-sync hook actively compare issue state (closed?) before firing nudges?

2. **`health.ts` bootstrap_pending check (lines 84–94) does NOT use INNER JOIN** — it counts `instance_user_roles` rows with `WHERE role = 'instance_admin' AND user_id <> 'local-board'` but without joining `public."user"`. Post-FK this is safe (orphans can't exist), but if the FK is ever dropped or bypassed, health could report "ready" while the INNER JOIN check in `runPostSignupBootstrap` sees zero real admins. Should the health query also use INNER JOIN for consistency? Minor belt-and-suspenders question.

3. **`services/access.ts:promoteInstanceAdmin` (lines 142–157) is read-then-insert without advisory lock.** It's the admin-UI "promote this user to admin" path, low-concurrency by design (a human is clicking a button). But the TOCTOU window exists. Should it share the advisory lock with the bootstrap path, or is the unique index `(user_id, role)` sufficient coverage for the admin-UI case?

4. **Full UUID for 785119d5 is NOT in the codebase.** The issue body uses a truncated form. If re-investigation is needed on a future orphan, the full UUID should be retrieved via `SELECT user_id FROM instance_user_roles WHERE role = 'instance_admin'` before any targeted DELETE. The `LIKE '785119d5%'` predicate is safe but an exact-match WHERE is always preferred for destructive operations.

5. **Supabase `auth.users` deletions bypass the FK** — the FK is on `public."user"` (Fly Postgres), not Supabase's `auth.users`. If a Supabase admin deletes a user from the Supabase dashboard, the Fly `public."user"` row persists (no FK link between the two DBs). That leaves a "ghost" user in `public."user"` with a valid `instance_user_roles` row — functionally locked out (no valid JWT) but not an orphan from the DB's perspective. Should there be a periodic reconciliation job or a Supabase webhook that deletes from `public."user"` when `auth.users` is deleted?

---

## 10. Conclusion

The action this investigation was tasked with validating (DELETE orphan row, verify, propose migration sketch) is **historically resolved**. Migration `0073_auth_mirror_orphan_guard.sql` shipped the structural fix; issue #66 confirmed zero orphans as of 2026-05-07; `runPostSignupBootstrap` is now FK-backed and INNER-JOIN-guarded.

The remaining live gap to flag for /council is question #2 (health check lacks INNER JOIN) and question #5 (cross-DB Supabase deletion creates ghost users, not orphans). Both are non-blocking P3 observations, not production incidents.

**Immediate action:** Mark the Vanta:ship ledger entry as resolved to stop the stale nudge.
