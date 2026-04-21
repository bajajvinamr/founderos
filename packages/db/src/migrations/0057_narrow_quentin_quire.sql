CREATE TABLE "instance_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"execution_mode" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"key_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_api_keys_family_mode_idx" ON "instance_api_keys" USING btree ("family","execution_mode");