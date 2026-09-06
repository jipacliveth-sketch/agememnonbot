import { pgTable, uuid, text, timestamp, jsonb, boolean, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

export const notificationStatusEnum = pgEnum("notification_status", ["PENDING", "SENT", "FAILED"]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  type: text("type").notNull(), // e.g. "DEPOSIT_CONFIRMED", "POSITION_OPENED"
  payload: jsonb("payload").notNull().default({}),
  status: notificationStatusEnum("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  dedupeKey: text("dedupe_key"),
}, (table) => ({
  userIdIdx: index("notifications_user_id_idx").on(table.userId),
  statusIdx: index("notifications_status_idx").on(table.status),
  dedupeUnique: uniqueIndex("notifications_dedupe_key_unique").on(table.dedupeKey),
}));

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  executionNotifications: boolean("execution_notifications").notNull().default(true),
  depositNotifications: boolean("deposit_notifications").notNull().default(true),
  withdrawalNotifications: boolean("withdrawal_notifications").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminRoleEnum = pgEnum("admin_role", ["SUPPORT", "OPERATOR", "SUPERADMIN"]);

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: adminRoleEnum("role").notNull().default("SUPPORT"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailUnique: uniqueIndex("admin_users_email_unique").on(table.email),
}));

/**
 * Immutable audit trail for every administrative action, especially
 * anything touching balances. Never update or delete rows here.
 */
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: uuid("admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
  action: text("action").notNull(), // e.g. "LEDGER_ADJUSTMENT", "ACCOUNT_SUSPENDED"
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reason: text("reason"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  targetIdx: index("audit_logs_target_idx").on(table.targetType, table.targetId),
  createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt),
}));

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("RUNNING"),
  issueCount: text("issue_count").notNull().default("0"),
  summary: jsonb("summary").notNull().default({}),
});

export const reconciliationIssues = pgTable("reconciliation_issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => reconciliationRuns.id, { onDelete: "restrict" }),
  severity: text("severity").notNull(),
  issueType: text("issue_type").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  walletId: uuid("wallet_id"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index("reconciliation_issues_run_idx").on(table.runId),
  severityIdx: index("reconciliation_issues_severity_idx").on(table.severity),
}));
