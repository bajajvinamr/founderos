CREATE TABLE "composio_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"app_name" text NOT NULL,
	"composio_connection_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composio_connections" ADD CONSTRAINT "composio_connections_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "composio_connections_company_user_app_unique" ON "composio_connections" ("company_id","user_id","app_name");
--> statement-breakpoint
CREATE INDEX "composio_connections_company_idx" ON "composio_connections" ("company_id");
--> statement-breakpoint
CREATE INDEX "composio_connections_user_idx" ON "composio_connections" ("user_id");
