import { pgTable, uuid, text, timestamp, numeric, integer, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

export const networkEnum = pgEnum("network", ["SOLANA", "ETHEREUM", "BASE", "BSC"]);

/**
 * Per-user deposit destinations. One row per (user, network, asset) at
 * minimum — supports the "deterministic per-user attribution" requirement
 * without hardcoding to one custody provider. `derivationPath`/`metadata`
 * let different provider implementations store what they need to re-derive
 * or watch the address without changing this table's shape.
 */
export const walletAddresses = pgTable("wallet_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  network: networkEnum("network").notNull(),
  asset: text("asset").notNull(),
  address: text("address").notNull(),
  memo: text("memo"), // for networks/assets that use memo/tag-based attribution
  derivationMetadata: text("derivation_metadata"), // opaque to app logic; provider-specific
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  addressUnique: uniqueIndex("wallet_addresses_address_unique").on(table.network, table.address),
  userNetworkAssetIdx: index("wallet_addresses_user_network_asset_idx").on(
    table.userId, table.network, table.asset
  ),
}));

export const depositStatusEnum = pgEnum("deposit_status", [
  "PENDING",
  "DETECTED",
  "CONFIRMING",
  "CONFIRMED",
  "FAILED",
  "REJECTED",
  "REVERSED",
]);

export const deposits = pgTable("deposits", {
  id: uuid("id").primaryKey().defaultRandom(),
  depositReference: text("deposit_reference").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  walletAddressId: uuid("wallet_address_id").references(() => walletAddresses.id, { onDelete: "restrict" }),
  // ^ nullable: null when this deposit went to a shared PLATFORM_DEPOSIT_ADDRESS
  // (see src/config/deposit-addresses.ts) rather than a per-user derived address.

  network: networkEnum("network").notNull(),
  asset: text("asset").notNull(),

  txHash: text("tx_hash"),
  fromAddress: text("from_address"),
  toAddress: text("to_address").notNull(),

  amount: numeric("amount", { precision: 30, scale: 12 }),
  confirmations: integer("confirmations").notNull().default(0),
  requiredConfirmations: integer("required_confirmations").notNull(),

  status: depositStatusEnum("status").notNull().default("PENDING"),

  detectedAt: timestamp("detected_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  depositReferenceUnique: uniqueIndex("deposits_deposit_reference_unique").on(table.depositReference),
  // A given on-chain tx can only ever back one deposit record per network —
  // this is the DB-level backstop against double-crediting.
  txHashNetworkUnique: uniqueIndex("deposits_tx_hash_network_unique").on(table.network, table.txHash),
  userIdIdx: index("deposits_user_id_idx").on(table.userId),
  statusIdx: index("deposits_status_idx").on(table.status),
}));

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "REQUESTED",
  "PENDING_REVIEW",
  "APPROVED",
  "FUNDS_RESERVED",
  "SIGNING",
  "BROADCAST",
  "CONFIRMING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const withdrawals = pgTable("withdrawals", {
  id: uuid("id").primaryKey().defaultRandom(),
  withdrawalReference: text("withdrawal_reference").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),

  network: networkEnum("network").notNull(),
  asset: text("asset").notNull(),
  destinationAddress: text("destination_address").notNull(),

  amount: numeric("amount", { precision: 30, scale: 12 }).notNull(),

  status: withdrawalStatusEnum("status").notNull().default("REQUESTED"),

  // Set once funds are reserved via a TRADE_RESERVATION-style ledger entry
  // (reference_type = 'withdrawal') so available balance reflects the hold.
  reservationLedgerEntryId: uuid("reservation_ledger_entry_id"),

  txHash: text("tx_hash"),

  failureReason: text("failure_reason"),

  reviewedByAdminId: uuid("reviewed_by_admin_id"),
  rejectionReason: text("rejection_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  withdrawalReferenceUnique: uniqueIndex("withdrawals_withdrawal_reference_unique").on(table.withdrawalReference),
  userIdIdx: index("withdrawals_user_id_idx").on(table.userId),
  statusIdx: index("withdrawals_status_idx").on(table.status),
}));

/**
 * Raw observed blockchain transactions, independent of whether they've
 * been matched to a deposit yet. Lets the blockchain watcher log
 * everything it sees before/while attribution happens.
 */
export const blockchainTransactions = pgTable("blockchain_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  network: networkEnum("network").notNull(),
  txHash: text("tx_hash").notNull(),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  asset: text("asset"),
  amount: numeric("amount", { precision: 30, scale: 12 }),
  confirmations: integer("confirmations").notNull().default(0),
  rawPayload: text("raw_payload"), // JSON string of provider response, for debugging/audit
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  txHashNetworkUnique: uniqueIndex("blockchain_transactions_tx_hash_network_unique").on(table.network, table.txHash),
}));
