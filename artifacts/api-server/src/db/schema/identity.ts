import { pgTable, uuid, text, timestamp, bigint, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "suspended",
  "closed",
]);

/**
 * The internal, stable account. This ID is what every other table
 * (wallets, deposits, strategy executions, etc.) references.
 * It must NEVER change once created, regardless of how many devices
 * or Telegram sessions the same person uses.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountReference: text("account_reference").notNull(), // e.g. human-friendly "AGM-8F31A"
  status: accountStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accountReferenceUnique: uniqueIndex("users_account_reference_unique").on(table.accountReference),
}));

/**
 * Telegram is the identity anchor. telegram_user_id is unique and immutable.
 * username/first_name/last_name are metadata only — never used for identity
 * resolution, since usernames can change or be dropped entirely.
 */
export const telegramIdentities = pgTable("telegram_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),

  // Telegram's user id is a 64-bit integer.
  telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),

  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  languageCode: text("language_code"),

  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  telegramUserIdUnique: uniqueIndex("telegram_identities_telegram_user_id_unique").on(table.telegramUserId),
  userIdIdx: index("telegram_identities_user_id_idx").on(table.userId),
}));
