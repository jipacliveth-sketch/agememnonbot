import { pgTable, uuid, text, timestamp, numeric, boolean, jsonb, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { networkEnum } from "./payments";

export const riskLevelEnum = pgEnum("risk_level", ["LOW", "MEDIUM", "HIGH"]);
export const strategyStatusEnum = pgEnum("strategy_status", ["AVAILABLE", "COMING_SOON", "DISABLED"]);

/**
 * Strategies are data, not code paths hardcoded into Telegram handlers.
 * Admin can create/edit/enable/disable rows here; the bot just renders
 * whatever is AVAILABLE.
 */
export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  network: networkEnum("network").notNull(),
  riskLevel: riskLevelEnum("risk_level").notNull(),
  status: strategyStatusEnum("status").notNull().default("COMING_SOON"),
  enabled: boolean("enabled").notNull().default(false),
  minimumBalance: numeric("minimum_balance", { precision: 20, scale: 8 }).notNull().default("0"),

  // Free-form strategy-specific config (e.g. take-profit %, slippage,
  // per-strategy engine parameters). Shape owned by the trading engine,
  // not by this schema.
  configuration: jsonb("configuration").notNull().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  slugUnique: uniqueIndex("strategies_slug_unique").on(table.slug),
}));

export const executionStatusEnum = pgEnum("strategy_execution_status", [
  "STARTING",
  "ACTIVE",
  "STOPPING",
  "STOPPED",
  "FAILED",
]);

/**
 * One row per "user started strategy X with $Y". This is the record
 * the app owns; the TRADING ENGINE owns what actually happens during
 * execution (positions/orders/trades below mirror engine state via
 * events, they are not authored directly by Telegram handlers).
 */
export const strategyExecutions = pgTable("strategy_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  strategyId: uuid("strategy_id").notNull().references(() => strategies.id, { onDelete: "restrict" }),

  allocatedAmount: numeric("allocated_amount", { precision: 20, scale: 8 }).notNull(),
  status: executionStatusEnum("status").notNull().default("STARTING"),

  // Set once the (future) trading engine acknowledges the start request.
  engineExecutionRef: text("engine_execution_ref"),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
}, (table) => ({
  userIdIdx: index("strategy_executions_user_id_idx").on(table.userId),
  statusIdx: index("strategy_executions_status_idx").on(table.status),
}));

export const positionStatusEnum = pgEnum("position_status", ["OPEN", "CLOSED"]);

/**
 * Mirrors trading-engine state for display in Telegram. Written only by
 * the event consumer in trading-engine/events.ts — never by user-facing
 * handlers directly.
 */
export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  strategyExecutionId: uuid("strategy_execution_id").notNull().references(() => strategyExecutions.id, { onDelete: "restrict" }),

  tokenSymbol: text("token_symbol").notNull(),
  tokenAddress: text("token_address"),

  entryPrice: numeric("entry_price", { precision: 30, scale: 12 }).notNull(),
  amount: numeric("amount", { precision: 20, scale: 8 }).notNull(),

  status: positionStatusEnum("status").notNull().default("OPEN"),
  realizedPnl: numeric("realized_pnl", { precision: 20, scale: 8 }),

  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => ({
  userIdIdx: index("positions_user_id_idx").on(table.userId),
  statusIdx: index("positions_status_idx").on(table.status),
}));

export const orderStatusEnum = pgEnum("order_status", ["CREATED", "SUBMITTED", "FILLED", "FAILED"]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  positionId: uuid("position_id").references(() => positions.id, { onDelete: "set null" }),
  engineOrderRef: text("engine_order_ref").notNull(),

  side: text("side").notNull(), // "BUY" | "SELL"
  status: orderStatusEnum("status").notNull().default("CREATED"),

  requestedAmount: numeric("requested_amount", { precision: 20, scale: 8 }).notNull(),
  filledAmount: numeric("filled_amount", { precision: 20, scale: 8 }),
  price: numeric("price", { precision: 30, scale: 12 }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  engineOrderRefUnique: uniqueIndex("orders_engine_order_ref_unique").on(table.engineOrderRef),
  userIdIdx: index("orders_user_id_idx").on(table.userId),
}));

export const trades = pgTable("trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),

  side: text("side").notNull(),
  amount: numeric("amount", { precision: 20, scale: 8 }).notNull(),
  price: numeric("price", { precision: 30, scale: 12 }).notNull(),
  feeAmount: numeric("fee_amount", { precision: 20, scale: 8 }).notNull().default("0"),

  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("trades_user_id_idx").on(table.userId),
}));
