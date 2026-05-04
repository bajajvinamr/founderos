-- Council 2026-05-04: structural insurance against the orphan-admin
-- production block. Two ops, in order:
--
--   (1) Delete any instance_user_roles rows whose user_id is not
--       'local-board' AND has no matching public."user" row. Pre-fix,
--       these orphans were treated as "an admin already exists" by
--       runPostSignupBootstrap and bricked first-user-wins promotion
--       for every subsequent founder.
--
--   (2) Add the missing FK on instance_user_roles.user_id -> "user".id
--       with ON DELETE CASCADE so deleting a user automatically wipes
--       their role rows. Without this constraint, the orphan failure
--       mode could recur whenever a row vanishes from "user".
--
-- Idempotent: the DELETE is no-op when zero orphans exist; ALTER ADD
-- CONSTRAINT errors if rerun, which is expected (single-shot migration).
--
-- local-board principal is seeded into "user" by
-- ensureLocalTrustedBoardPrincipal in local_trusted dev mode, so the FK
-- is satisfied. In authenticated (prod) mode, local-board is never
-- inserted into instance_user_roles, so the FK is trivially satisfied.

DELETE FROM "instance_user_roles"
WHERE "user_id" <> 'local-board'
  AND NOT EXISTS (
    SELECT 1 FROM "public"."user" u WHERE u.id = "instance_user_roles"."user_id"
  );

ALTER TABLE "instance_user_roles"
  ADD CONSTRAINT "instance_user_roles_user_id_user_id_fk"
  FOREIGN KEY ("user_id")
  REFERENCES "public"."user"("id")
  ON DELETE cascade
  ON UPDATE no action;
