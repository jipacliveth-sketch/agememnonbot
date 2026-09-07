import { pgEnum, pgTable, uuid, text, numeric, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

export const simulationTypeEnum = pgEnum("simulation_type", ["TRADE", "SNIPER"]);
export const simulationStatusEnum = pgEnum("simulation_status", ["STARTING", "RUNNING", "COMPLETED", "STOPPED", "FAILED"]);
export const simulationTradeOutcomeEnum = pgEnum("simulation_trade_outcome", ["TAKE_PROFIT", "STOP_LOSS", "TIMEOUT"]);

export const simulationSessions = pgTable("simulation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  type: simulationTypeEnum("type").notNull(),
  status: simulationStatusEnum("status").notNull().default("STARTING"),
  tokenSymbol: text("token_symbol").notNull(),
  marketId: text("market_id").notNull(),
  entryPrice: numeric("entry_price", { precision: 30, scale: 12 }).notNull(),
  currentPrice: numeric("current_price", { precision: 30, scale: 12 }).notNull(),
  positionSize: numeric("position_size", { precision: 20, scale: 8 }).notNull(),
  takeProfit: numeric("take_profit", { precision: 30, scale: 12 }).notNull(),
  stopLoss: numeric("stop_loss", { precision: 30, scale: 12 }).notNull(),
  startingBalance: numeric("starting_balance", { precision: 20, scale: 8 }).notNull(),
  endingBalance: numeric("ending_balance", { precision: 20, scale: 8 }),
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  losingTrades: integer("losing_trades").notNull().default(0),
  takeProfits: integer("take_profits").notNull().default(0),
  stopLosses: integer("stop_losses").notNull().default(0),
  grossPnl: numeric("gross_pnl", { precision: 20, scale: 8 }).notNull().default("0"),
  fees: numeric("fees", { precision: 20, scale: 8 }).notNull().default("0"),
  netPnl: numeric("net_pnl", { precision: 20, scale: 8 }).notNull().default("0"),
  runtimeSeconds: integer("runtime_seconds").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userTypeStatusIdx: index("simulation_sessions_user_type_status_idx").on(table.userId, table.type, table.status),
  userStartedIdx: index("simulation_sessions_user_started_idx").on(table.userId, table.startedAt),
}));

export const simulationTrades = pgTable("simulation_trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => simulationSessions.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  tokenSymbol: text("token_symbol").notNull(),
  entryPrice: numeric("entry_price", { precision: 30, scale: 12 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 30, scale: 12 }).notNull(),
  positionSize: numeric("position_size", { precision: 20, scale: 8 }).notNull(),
  grossPnl: numeric("gross_pnl", { precision: 20, scale: 8 }).notNull(),
  feeAmount: numeric("fee_amount", { precision: 20, scale: 8 }).notNull(),
  netPnl: numeric("net_pnl", { precision: 20, scale: 8 }).notNull(),
  outcome: simulationTradeOutcomeEnum("outcome").notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: index("simulation_trades_session_idx").on(table.sessionId),
  userIdx: index("simulation_trades_user_idx").on(table.userId),
  ledgerReferenceUnique: uniqueIndex("simulation_trades_ledger_reference_unique").on(table.id),
}));

export const sniperUsage = pgTable("sniper_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  sessionId: uuid("session_id").notNull().references(() => simulationSessions.id, { onDelete: "restrict" }),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userUsedIdx: index("sniper_usage_user_used_idx").on(table.userId, table.usedAt),
  sessionUnique: uniqueIndex("sniper_usage_session_unique").on(table.sessionId),
}));