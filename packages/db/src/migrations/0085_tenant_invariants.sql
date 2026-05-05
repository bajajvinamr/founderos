-- 2026-05-05 — Tenant invariants (TC-3, council 2026-05-05 R1+R2 P2)
--
-- Council finding (verbatim, decisions.md 2026-05-05):
--   [P2] Tenant invariants enforced in app code, not Postgres —
--   packages/db/src/schema/runner.ts:94-107+126, heartbeat_runs.ts:10-14,
--   issue_labels.ts:9-11, execution_workspaces.ts:19-22 all carry company_id
--   + parent FK but no composite FK proves parent belongs to same company;
--   scheduler state is raw text with no CHECK.
--
--   Fix: parent (id, company_id) unique keys, child composite FK, CHECK
--   constraints for status/state enums before S4 schema growth.
--
-- Why this lands as one migration:
--   1. Multiple ALTER TABLEs on the same target take separate ACCESS EXCLUSIVE
--      locks. Combining all clauses on a given table into one ALTER acquires
--      the lock once and releases it immediately. See vinamr-invariants
--      Postgres entry 2026-05-05.
--   2. Composite FKs require the parent to expose a UNIQUE constraint over
--      (id, company_id) BEFORE the child constraint is created. UNIQUE adds
--      first, FKs second. Postgres validates referential integrity at
--      constraint-create time so the parent UNIQUE must already exist.
--
-- Parent → child topology:
--   companies               <— (already PK on id)
--   agents                  ← runner_jobs.agent_id, heartbeat_runs.agent_id
--   heartbeat_runs          ← runner_jobs.heartbeat_run_id
--   agent_wakeup_requests   ← heartbeat_runs.wakeup_request_id (nullable FK)
--   issues                  ← issue_labels.issue_id, execution_workspaces.source_issue_id (nullable)
--   labels                  ← issue_labels.label_id
--   projects                ← execution_workspaces.project_id
--   project_workspaces      ← execution_workspaces.project_workspace_id (nullable FK)
--
-- Existing simple FKs (single-column references) remain in place. The new
-- composite FKs are additive: the simple FK proves "parent row exists",
-- the composite FK proves "parent row exists AND its company_id matches
-- the child's company_id". Postgres enforces both on insert/update.
--
-- Nullable FK columns:
--   heartbeat_runs.wakeup_request_id, execution_workspaces.source_issue_id,
--   and execution_workspaces.project_workspace_id are nullable. A composite
--   FK with NULL in either column is exempt from the check (MATCH SIMPLE,
--   the Postgres default) — this is correct: if the child has no parent,
--   there's nothing to enforce same-tenant on.
--
-- CHECK constraints — three columns get an explicit DB-level enum:
--   runner_jobs.status:
--     queued | claimed | streaming | completed | failed | cancelled
--     (matches RunnerJobStatus type union in packages/db/src/schema/runner.ts)
--
--   heartbeat_runs.status:
--     queued | running | succeeded | failed | cancelled | timed_out | coalesced
--     (matches HEARTBEAT_RUN_STATUSES in packages/shared/src/constants.ts
--      plus 'coalesced' which the heartbeat scheduler writes when a wakeup
--      request is folded into an in-flight run — verified at
--      server/src/services/heartbeat.ts:3161 and :3344)
--
--   execution_workspaces.status:
--     active | idle | in_review | archived | cleanup_failed
--     (matches ExecutionWorkspaceStatus in packages/shared/src/types/workspace-runtime.ts)
--
-- Lock duration:
--   Each ALTER TABLE statement holds ACCESS EXCLUSIVE on its target for the
--   duration of constraint validation. NOT VALID is NOT used here because:
--     (a) These are tiny tables (< 10K rows in any production tenant);
--     (b) Validation is cheap on populated rows that already satisfy the
--         constraint (the application has been writing same-tenant data
--         throughout — the council finding is about defense-in-depth, not
--         data corruption);
--     (c) Wave 3 + Sprint 4 work hasn't shipped yet, so the rollout window
--         is during the same maintenance pass as the rest of TC-* fixes.
--
-- Idempotency: ADD CONSTRAINT IF NOT EXISTS is unfortunately not portable
--   in Postgres for unique/foreign/check (it works only for indexes via
--   CREATE INDEX IF NOT EXISTS). We rely on the migration ledger gate —
--   _journal.json idx 82 ensures this only runs once per database.
--
-- Rollback:
--   ALTER TABLE "execution_workspaces"
--     DROP CONSTRAINT IF EXISTS "execution_workspaces_status_check",
--     DROP CONSTRAINT IF EXISTS "execution_workspaces_project_id_company_id_projects_id_company_id_fk",
--     DROP CONSTRAINT IF EXISTS "execution_workspaces_project_workspace_id_company_id_project_workspaces_id_company_id_fk",
--     DROP CONSTRAINT IF EXISTS "execution_workspaces_source_issue_id_company_id_issues_id_company_id_fk";
--   ALTER TABLE "issue_labels"
--     DROP CONSTRAINT IF EXISTS "issue_labels_issue_id_company_id_issues_id_company_id_fk",
--     DROP CONSTRAINT IF EXISTS "issue_labels_label_id_company_id_labels_id_company_id_fk";
--   ALTER TABLE "heartbeat_runs"
--     DROP CONSTRAINT IF EXISTS "heartbeat_runs_status_check",
--     DROP CONSTRAINT IF EXISTS "heartbeat_runs_agent_id_company_id_agents_id_company_id_fk",
--     DROP CONSTRAINT IF EXISTS "heartbeat_runs_wakeup_request_id_company_id_agent_wakeup_requests_id_company_id_fk";
--   ALTER TABLE "runner_jobs"
--     DROP CONSTRAINT IF EXISTS "runner_jobs_status_check",
--     DROP CONSTRAINT IF EXISTS "runner_jobs_agent_id_company_id_agents_id_company_id_fk",
--     DROP CONSTRAINT IF EXISTS "runner_jobs_heartbeat_run_id_company_id_heartbeat_runs_id_company_id_fk";
--   ALTER TABLE "agents"               DROP CONSTRAINT IF EXISTS "agents_id_company_id_uq";
--   ALTER TABLE "heartbeat_runs"       DROP CONSTRAINT IF EXISTS "heartbeat_runs_id_company_id_uq";
--   ALTER TABLE "agent_wakeup_requests" DROP CONSTRAINT IF EXISTS "agent_wakeup_requests_id_company_id_uq";
--   ALTER TABLE "issues"               DROP CONSTRAINT IF EXISTS "issues_id_company_id_uq";
--   ALTER TABLE "labels"               DROP CONSTRAINT IF EXISTS "labels_id_company_id_uq";
--   ALTER TABLE "projects"             DROP CONSTRAINT IF EXISTS "projects_id_company_id_uq";
--   ALTER TABLE "project_workspaces"   DROP CONSTRAINT IF EXISTS "project_workspaces_id_company_id_uq";

--------------------------------------------------------------------------
-- Phase 1: Parent UNIQUE keys on (id, company_id)
--------------------------------------------------------------------------
-- These are referenceable by composite FKs. Each is a no-op redundancy
-- against the existing PK (id) — adding a second uniqueness signal does
-- not duplicate rows, but lets us name the (id, company_id) tuple as a
-- valid FK target.

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "heartbeat_runs"
  ADD CONSTRAINT "heartbeat_runs_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "agent_wakeup_requests"
  ADD CONSTRAINT "agent_wakeup_requests_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "issues"
  ADD CONSTRAINT "issues_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "labels"
  ADD CONSTRAINT "labels_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

ALTER TABLE "project_workspaces"
  ADD CONSTRAINT "project_workspaces_id_company_id_uq" UNIQUE ("id", "company_id");
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 2: Child composite FKs + status CHECKs
--   One ALTER per child table, multiple clauses combined to take
--   ACCESS EXCLUSIVE once per table.
--------------------------------------------------------------------------

-- runner_jobs: composite FKs into agents + heartbeat_runs, plus status enum
ALTER TABLE "runner_jobs"
  ADD CONSTRAINT "runner_jobs_agent_id_company_id_agents_id_company_id_fk"
    FOREIGN KEY ("agent_id", "company_id")
    REFERENCES "agents" ("id", "company_id")
    ON DELETE cascade,
  ADD CONSTRAINT "runner_jobs_heartbeat_run_id_company_id_heartbeat_runs_id_company_id_fk"
    FOREIGN KEY ("heartbeat_run_id", "company_id")
    REFERENCES "heartbeat_runs" ("id", "company_id")
    ON DELETE cascade,
  ADD CONSTRAINT "runner_jobs_status_check"
    CHECK ("status" IN ('queued','claimed','streaming','completed','failed','cancelled'));
--> statement-breakpoint

-- heartbeat_runs: composite FKs into agents + agent_wakeup_requests (nullable),
-- plus status enum.
ALTER TABLE "heartbeat_runs"
  ADD CONSTRAINT "heartbeat_runs_agent_id_company_id_agents_id_company_id_fk"
    FOREIGN KEY ("agent_id", "company_id")
    REFERENCES "agents" ("id", "company_id"),
  ADD CONSTRAINT "heartbeat_runs_wakeup_request_id_company_id_agent_wakeup_requests_id_company_id_fk"
    FOREIGN KEY ("wakeup_request_id", "company_id")
    REFERENCES "agent_wakeup_requests" ("id", "company_id"),
  ADD CONSTRAINT "heartbeat_runs_status_check"
    CHECK ("status" IN ('queued','running','succeeded','failed','cancelled','timed_out','coalesced'));
--> statement-breakpoint

-- issue_labels: composite FKs into issues + labels
ALTER TABLE "issue_labels"
  ADD CONSTRAINT "issue_labels_issue_id_company_id_issues_id_company_id_fk"
    FOREIGN KEY ("issue_id", "company_id")
    REFERENCES "issues" ("id", "company_id")
    ON DELETE cascade,
  ADD CONSTRAINT "issue_labels_label_id_company_id_labels_id_company_id_fk"
    FOREIGN KEY ("label_id", "company_id")
    REFERENCES "labels" ("id", "company_id")
    ON DELETE cascade;
--> statement-breakpoint

-- execution_workspaces: composite FKs into projects + project_workspaces (nullable)
-- + source issue (nullable), plus status enum.
ALTER TABLE "execution_workspaces"
  ADD CONSTRAINT "execution_workspaces_project_id_company_id_projects_id_company_id_fk"
    FOREIGN KEY ("project_id", "company_id")
    REFERENCES "projects" ("id", "company_id")
    ON DELETE cascade,
  ADD CONSTRAINT "execution_workspaces_project_workspace_id_company_id_project_workspaces_id_company_id_fk"
    FOREIGN KEY ("project_workspace_id", "company_id")
    REFERENCES "project_workspaces" ("id", "company_id")
    ON DELETE set null,
  ADD CONSTRAINT "execution_workspaces_source_issue_id_company_id_issues_id_company_id_fk"
    FOREIGN KEY ("source_issue_id", "company_id")
    REFERENCES "issues" ("id", "company_id")
    ON DELETE set null,
  ADD CONSTRAINT "execution_workspaces_status_check"
    CHECK ("status" IN ('active','idle','in_review','archived','cleanup_failed'));
