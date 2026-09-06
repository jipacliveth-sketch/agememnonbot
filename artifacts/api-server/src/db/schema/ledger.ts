import { pgTable, uuid, text, timestamp, numeric, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { networkEnum } from "./payments";

/**
 * One wallet per user (extendable to per-asset wallets later by adding
 * an `asset` column + composite unique constraint, if multi-asset native
 * balances are needed instead of a single USD-denominated balance).
 */
export const wallets = pgTable("wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),

  // Denormalized, cached balances for fast reads. These are DERIVED from
  // ledger_entries and must be reconciled against them — never treated as
  // the sole source of truth. See services/ledger.ts for reconciliation.
  availableBalance: numeric("available_balance", { precision: 20, scale: 8 }).notNull().default("0"),
  lockedBalance: numeric("locked_balance", { precision: 20, scale: 8 }).notNull().default("0"),

  currency: text("currency").notNull().default("USD"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdUnique: uniqueIndex("wallets_user_id_unique").on(table.userId),
}));

/**
 * Asset-level balances are the source of truth for on-chain money movement.
 * The legacy USD cache above remains for existing installations; new
 * deposits and withdrawals use this table and ledgerEntries.currency.
 */
export const walletBalances = pgTable("wallet_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  network: networkEnum("network").notNull(),
  asset: text("asset").notNull(),
  availableBalance: numeric("available_balance", { precision: 30, scale: 12 }).notNull().default("0"),
  lockedBalance: numeric("locked_balance", { precision: 30, scale: 12 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  walletAssetUnique: uniqueIndex("wallet_balances_wallet_network_asset_unique").on(
    table.walletId, table.network, table.asset
  ),
  userAssetIdx: index("wallet_balances_user_network_asset_idx").on(
    table.userId, table.network, table.asset
  ),
}));

export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRADE_RESERVATION",
  "TRADE_RELEASE",
  "WITHDRAWAL_RESERVATION",
  "WITHDRAWAL_RELEASE",
  "TRADING_PROFIT",
  "TRADING_LOSS",
  "FEE",
  "ADJUSTMENT",
]);

export const ledgerEntryStatusEnum = pgEnum("ledger_entry_status", [
  "PENDING",
  "POSTED",
  "REVERSED",
]);

/**
 * Append-only ledger. Every balance-changing event creates a row here.
 * Wallet balances are derived from summing POSTED entries per wallet.
 * Never UPDATE amount/type on an existing entry — to correct a mistake,
 * post an offsetting ADJUSTMENT entry and mark the original REVERSED.
 */
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),

  type: ledgerEntryTypeEnum("type").notNull(),
  status: ledgerEntryStatusEnum("status").notNull().default("PENDING"),

  // Positive for credits, negative for debits — sign convention enforced
  // in services/ledger.ts, not left to callers to get right ad hoc.
  amount: numeric("amount", { precision: 20, scale: 8 }).notNull(),
  currency: text("currency").notNull().default("USD"),

  // Polymorphic reference to the source record (deposit id, withdrawal id,
  // strategy_execution id, trade id, admin adjustment id, etc.)
  referenceType: text("reference_type").notNull(),
  referenceId: uuid("reference_id").notNull(),

  // Free-text note — required for ADJUSTMENT entries (see services/ledger.ts).
  note: text("note"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  walletIdIdx: index("ledger_entries_wallet_id_idx").on(table.walletId),
  userIdIdx: index("ledger_entries_user_id_idx").on(table.userId),
  referenceIdx: index("ledger_entries_reference_idx").on(table.referenceType, table.referenceId),
  // Prevents the same source event from posting the same ledger effect twice.
  idempotencyUnique: uniqueIndex("ledger_entries_idempotency_unique").on(
    table.referenceType,
    table.referenceId,
    table.type
  ),
}));
