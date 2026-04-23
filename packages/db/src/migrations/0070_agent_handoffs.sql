CREATE TABLE "agent_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"from_issue_id" uuid,
	"to_issue_id" uuid,
	"request" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" text,
	"result_ref" text
);
--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_from_agent_fk" FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_handoffs" ADD CONSTRAINT "agent_handoffs_to_agent_fk" FOREIGN KEY ("to_agent_id") REFERENCES "agents"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "agent_handoffs_to_agent_status_idx" ON "agent_handoffs" ("company_id","to_agent_id","status");
--> statement-breakpoint
CREATE INDEX "agent_handoffs_from_agent_idx" ON "agent_handoffs" ("from_agent_id","status");
--> statement-breakpoint
CREATE INDEX "agent_handoffs_from_issue_idx" ON "agent_handoffs" ("from_issue_id");
