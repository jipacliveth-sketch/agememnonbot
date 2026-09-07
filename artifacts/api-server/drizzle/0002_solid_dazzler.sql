DO $$ BEGIN
 CREATE TYPE "public"."simulation_status" AS ENUM('STARTING', 'RUNNING', 'COMPLETED', 'STOPPED', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."simulation_trade_outcome" AS ENUM('TAKE_PROFIT', 'STOP_LOSS', 'TIMEOUT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."simulation_type" AS ENUM('TRADE', 'SNIPER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "simulation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "simulation_type" NOT NULL,
	"status" "simulation_status" DEFAULT 'STARTING' NOT NULL,
	"token_symbol" text NOT NULL,
	"market_id" text NOT NULL,
	"entry_price" numeric(30, 12) NOT NULL,
	"current_price" numeric(30, 12) NOT NULL,
	"position_size" numeric(20, 8) NOT NULL,
	"take_profit" numeric(30, 12) NOT NULL,
	"stop_loss" numeric(30, 12) NOT NULL,
	"starting_balance" numeric(20, 8) NOT NULL,
	"ending_balance" numeric(20, 8),
	"total_trades" integer DEFAULT 0 NOT NULL,
	"winning_trades" integer DEFAULT 0 NOT NULL,
	"losing_trades" integer DEFAULT 0 NOT NULL,
	"take_profits" integer DEFAULT 0 NOT NULL,
	"stop_losses" integer DEFAULT 0 NOT NULL,
	"gross_pnl" numeric(20, 8) DEFAULT '0' NOT NULL,
	"fees" numeric(20, 8) DEFAULT '0' NOT NULL,
	"net_pnl" numeric(20, 8) DEFAULT '0' NOT NULL,
	"runtime_seconds" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "simulation_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_symbol" text NOT NULL,
	"entry_price" numeric(30, 12) NOT NULL,
	"exit_price" numeric(30, 12) NOT NULL,
	"position_size" numeric(20, 8) NOT NULL,
	"gross_pnl" numeric(20, 8) NOT NULL,
	"fee_amount" numeric(20, 8) NOT NULL,
	"net_pnl" numeric(20, 8) NOT NULL,
	"outcome" "simulation_trade_outcome" NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sniper_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_sessions" ADD CONSTRAINT "simulation_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_trades" ADD CONSTRAINT "simulation_trades_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."simulation_sessions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_trades" ADD CONSTRAINT "simulation_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sniper_usage" ADD CONSTRAINT "sniper_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sniper_usage" ADD CONSTRAINT "sniper_usage_session_id_simulation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."simulation_sessions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulation_sessions_user_type_status_idx" ON "simulation_sessions" USING btree ("user_id","type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulation_sessions_user_started_idx" ON "simulation_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulation_trades_session_idx" ON "simulation_trades" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "simulation_trades_user_idx" ON "simulation_trades" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "simulation_trades_ledger_reference_unique" ON "simulation_trades" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sniper_usage_user_used_idx" ON "sniper_usage" USING btree ("user_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sniper_usage_session_unique" ON "sniper_usage" USING btree ("session_id");