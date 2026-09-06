ALTER TYPE "ledger_entry_type" ADD VALUE 'WITHDRAWAL_RESERVATION';--> statement-breakpoint
ALTER TYPE "ledger_entry_type" ADD VALUE 'WITHDRAWAL_RELEASE';--> statement-breakpoint
ALTER TYPE "withdrawal_status" ADD VALUE 'FUNDS_RESERVED';--> statement-breakpoint
ALTER TYPE "withdrawal_status" ADD VALUE 'SIGNING';--> statement-breakpoint
ALTER TYPE "withdrawal_status" ADD VALUE 'CONFIRMING';--> statement-breakpoint
ALTER TYPE "withdrawal_status" ADD VALUE 'COMPLETED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"asset" text NOT NULL,
	"available_balance" numeric(30, 12) DEFAULT '0' NOT NULL,
	"locked_balance" numeric(30, 12) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"issue_type" text NOT NULL,
	"user_id" uuid,
	"wallet_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"issue_count" text DEFAULT '0' NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"execution_notifications" boolean DEFAULT true NOT NULL,
	"deposit_notifications" boolean DEFAULT true NOT NULL,
	"withdrawal_notifications" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_balances_wallet_network_asset_unique" ON "wallet_balances" USING btree ("wallet_id","network","asset");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_balances_user_network_asset_idx" ON "wallet_balances" USING btree ("user_id","network","asset");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_issues_run_idx" ON "reconciliation_issues" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_issues_severity_idx" ON "reconciliation_issues" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_key_unique" ON "notifications" USING btree ("dedupe_key");