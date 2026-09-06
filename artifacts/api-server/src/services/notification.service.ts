import { and, eq, isNull } from "drizzle-orm";
import { GrammyError, HttpError } from "grammy";
import { Database } from "../db/client";
import { notifications, telegramIdentities, userSettings } from "../db/schema";
import { logError } from "../lib/logger";

export type NotificationType =
  | "DEPOSIT_DETECTED"
  | "DEPOSIT_CONFIRMED"
  | "STRATEGY_STARTED"
  | "STRATEGY_STOPPED"
  | "TRADE_EXECUTED"
  | "WITHDRAWAL_STATUS";

export async function enqueueNotification(
  db: Database,
  params: { userId: string; type: NotificationType; payload: Record<string, unknown>; dedupeKey: string }
) {
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, params.userId) });
  if (settings && !settings.notificationsEnabled) return null;
  if (settings && params.type.startsWith("DEPOSIT") && !settings.depositNotifications) return null;
  if (settings && params.type.startsWith("WITHDRAWAL") && !settings.withdrawalNotifications) return null;
  if (settings && (params.type.startsWith("STRATEGY") || params.type === "TRADE_EXECUTED") && !settings.executionNotifications) return null;

  const [row] = await db.insert(notifications).values({
    userId: params.userId,
    type: params.type,
    payload: params.payload,
    dedupeKey: params.dedupeKey,
  }).onConflictDoNothing({ target: notifications.dedupeKey }).returning();
  return row ?? null;
}

export async function dispatchPendingNotifications(
  db: Database,
  send: (telegramUserId: bigint, text: string) => Promise<void>,
  limit = 50
) {
  const pending = await db.query.notifications.findMany({
    where: eq(notifications.status, "PENDING"),
    limit,
  });
  for (const item of pending) {
    const identity = await db.query.telegramIdentities.findFirst({
      where: eq(telegramIdentities.userId, item.userId),
    });
    if (!identity) {
      await db.update(notifications).set({ status: "FAILED" }).where(eq(notifications.id, item.id));
      continue;
    }
    try {
      await send(identity.telegramUserId, formatNotification(item.type, item.payload as Record<string, unknown>));
      await db.update(notifications).set({ status: "SENT", sentAt: new Date() }).where(
        and(eq(notifications.id, item.id), eq(notifications.status, "PENDING"))
      );
    } catch (error) {
      if (isTransientDeliveryError(error)) {
        // Leave transiently undeliverable notifications pending so the next
        // worker cycle can retry them instead of permanently losing delivery.
        logError("notification_delivery_retryable_failure", error, {
          notificationId: item.id,
        });
      } else {
        await db.update(notifications).set({ status: "FAILED" }).where(
          and(eq(notifications.id, item.id), eq(notifications.status, "PENDING"))
        );
        logError("notification_delivery_permanent_failure", error, {
          notificationId: item.id,
        });
      }
    }
  }
}

function isTransientDeliveryError(error: unknown) {
  if (error instanceof HttpError) return true;
  return error instanceof GrammyError &&
    (error.error_code === 429 || error.error_code >= 500);
}

function formatNotification(type: string, payload: Record<string, unknown>) {
  switch (type) {
    case "DEPOSIT_DETECTED":
      return `🔎 Deposit detected\n\n${String(payload.asset)} on ${String(payload.network)}\nStatus: confirming`;
    case "DEPOSIT_CONFIRMED":
      return `✅ Deposit confirmed\n\n${String(payload.amount)} ${String(payload.asset)}\nAvailable funds updated.`;
    case "STRATEGY_STARTED":
      return `✅ Strategy started\n\n${String(payload.strategyName)}`;
    case "STRATEGY_STOPPED":
      return `⏹ Strategy stopped\n\n${String(payload.strategyName)}`;
    case "TRADE_EXECUTED":
      return `📈 Trade executed\n\n${String(payload.side)} ${String(payload.amount)} ${String(payload.asset)} at ${String(payload.price)}`;
    case "WITHDRAWAL_STATUS":
      return `💸 Withdrawal update\n\n${String(payload.amount)} ${String(payload.asset)}\nStatus: ${String(payload.status)}`;
    default:
      return "Account activity update";
  }
}