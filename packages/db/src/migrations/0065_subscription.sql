CREATE TABLE "instance_subscription" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "plan" text NOT NULL DEFAULT 'free',
  "status" text NOT NULL DEFAULT 'inactive',
  "current_period_end" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_instance_subscription_stripe_customer" ON "instance_subscription" ("stripe_customer_id");
CREATE INDEX "idx_instance_subscription_stripe_sub" ON "instance_subscription" ("stripe_subscription_id");
