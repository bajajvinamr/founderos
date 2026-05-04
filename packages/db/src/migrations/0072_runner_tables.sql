-- BYO Runner — ADR-011 (2026-05-04)
-- runner_tokens: long-lived bearer tokens for the local runner. Plaintext
-- shown once at issuance; only sha256 hash persisted. Constant-time compare
-- on lookup. Revoke flips revoked_at.
-- runner_jobs: queue entries the runner polls. Materialized prompt + runtime
-- config so the runner can spawn `claude --print` without a second cloud round-trip.

CREATE TABLE "runner_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tokens_token_hash_unique" ON "runner_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "runner_tokens_company_active_idx" ON "runner_tokens" ("company_id","revoked_at");
--> statement-breakpoint
CREATE TABLE "runner_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"session_id_hint" text,
	"runtime_config" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claimed_by_token_id" uuid,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"elapsed_ms" bigint,
	"cost_micros" bigint,
	"session_id_after" text,
	"cli_version" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_heartbeat_run_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "runner_jobs" ADD CONSTRAINT "runner_jobs_claimed_by_token_id_fk" FOREIGN KEY ("claimed_by_token_id") REFERENCES "runner_tokens"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "runner_jobs_company_status_created_idx" ON "runner_jobs" ("company_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "runner_jobs_claimed_by_idx" ON "runner_jobs" ("claimed_by_token_id");
--> statement-breakpoint
CREATE INDEX "runner_jobs_heartbeat_run_idx" ON "runner_jobs" ("heartbeat_run_id");
