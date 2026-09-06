DO $$ BEGIN
 CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ledger_entry_status" AS ENUM('PENDING', 'POSTED', 'REVERSED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ledger_entry_type" AS ENUM('DEPOSIT', 'WITHDRAWAL', 'TRADE_RESERVATION', 'TRADE_RELEASE', 'TRADING_PROFIT', 'TRADING_LOSS', 'FEE', 'ADJUSTMENT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."deposit_status" AS ENUM('PENDING', 'DETECTED', 'CONFIRMING', 'CONFIRMED', 'FAILED', 'REJECTED', 'REVERSED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."network" AS ENUM('SOLANA', 'ETHEREUM', 'BASE', 'BSC');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."withdrawal_status" AS ENUM('REQUESTED', 'PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'BROADCAST', 'CONFIRMED', 'FAILED', 'REJECTED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."strategy_execution_status" AS ENUM('STARTING', 'ACTIVE', 'STOPPING', 'STOPPED', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'SUBMITTED', 'FILLED', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."position_status" AS ENUM('OPEN', 'CLOSED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."strategy_status" AS ENUM('AVAILABLE', 'COMING_SOON', 'DISABLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."admin_role" AS ENUM('SUPPORT', 'OPERATOR', 'SUPERADMIN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_reference" text NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"status" "ledger_entry_status" DEFAULT 'PENDING' NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"available_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"locked_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blockchain_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" "network" NOT NULL,
	"tx_hash" text NOT NULL,
	"from_address" text,
	"to_address" text,
	"asset" text,
	"amount" numeric(30, 12),
	"confirmations" integer DEFAULT 0 NOT NULL,
	"raw_payload" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_address_id" uuid,
	"network" "network" NOT NULL,
	"asset" text NOT NULL,
	"tx_hash" text,
	"from_address" text,
	"to_address" text NOT NULL,
	"amount" numeric(30, 12),
	"confirmations" integer DEFAULT 0 NOT NULL,
	"required_confirmations" integer NOT NULL,
	"status" "deposit_status" DEFAULT 'PENDING' NOT NULL,
	"detected_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"asset" text NOT NULL,
	"address" text NOT NULL,
	"memo" text,
	"derivation_metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"withdrawal_reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"asset" text NOT NULL,
	"destination_address" text NOT NULL,
	"amount" numeric(30, 12) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'REQUESTED' NOT NULL,
	"reservation_ledger_entry_id" uuid,
	"tx_hash" text,
	"reviewed_by_admin_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid,
	"engine_order_ref" text NOT NULL,
	"side" text NOT NULL,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"requested_amount" numeric(20, 8) NOT NULL,
	"filled_amount" numeric(20, 8),
	"price" numeric(30, 12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_execution_id" uuid NOT NULL,
	"token_symbol" text NOT NULL,
	"token_address" text,
	"entry_price" numeric(30, 12) NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"status" "position_status" DEFAULT 'OPEN' NOT NULL,
	"realized_pnl" numeric(20, 8),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"network" "network" NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"status" "strategy_status" DEFAULT 'COMING_SOON' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"minimum_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"allocated_amount" numeric(20, 8) NOT NULL,
	"status" "strategy_execution_status" DEFAULT 'STARTING' NOT NULL,
	"engine_execution_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"side" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"price" numeric(30, 12) NOT NULL,
	"fee_amount" numeric(20, 8) DEFAULT '0' NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "admin_role" DEFAULT 'SUPPORT' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_identities" ADD CONSTRAINT "telegram_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_wallet_address_id_wallet_addresses_id_fk" FOREIGN KEY ("wallet_address_id") REFERENCES "public"."wallet_addresses"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_addresses" ADD CONSTRAINT "wallet_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_execution_id_strategy_executions_id_fk" FOREIGN KEY ("strategy_execution_id") REFERENCES "public"."strategy_executions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_executions" ADD CONSTRAINT "strategy_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_executions" ADD CONSTRAINT "strategy_executions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_identities_telegram_user_id_unique" ON "telegram_identities" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_identities_user_id_idx" ON "telegram_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_account_reference_unique" ON "users" USING btree ("account_reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_wallet_id_idx" ON "ledger_entries" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_user_id_idx" ON "ledger_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_reference_idx" ON "ledger_entries" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_entries_idempotency_unique" ON "ledger_entries" USING btree ("reference_type","reference_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_user_id_unique" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blockchain_transactions_tx_hash_network_unique" ON "blockchain_transactions" USING btree ("network","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposits_deposit_reference_unique" ON "deposits" USING btree ("deposit_reference");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposits_tx_hash_network_unique" ON "deposits" USING btree ("network","tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_user_id_idx" ON "deposits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_status_idx" ON "deposits" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_addresses_address_unique" ON "wallet_addresses" USING btree ("network","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_addresses_user_network_asset_idx" ON "wallet_addresses" USING btree ("user_id","network","asset");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_withdrawal_reference_unique" ON "withdrawals" USING btree ("withdrawal_reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_user_id_idx" ON "withdrawals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_status_idx" ON "withdrawals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_engine_order_ref_unique" ON "orders" USING btree ("engine_order_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_id_idx" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_slug_unique" ON "strategies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_executions_user_id_idx" ON "strategy_executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_executions_status_idx" ON "strategy_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_user_id_idx" ON "trades" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_email_unique" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_status_idx" ON "notifications" USING btree ("status");