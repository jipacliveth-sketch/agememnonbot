import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { userSettings, users } from "../../db/schema";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";

export async function settingsHandler(ctx: BotContext) {
  const userId = ctx.session.userId!;
  let settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (!settings) {
    [settings] = await db.insert(userSettings).values({ userId }).returning();
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const text = [
    "⚙️ SETTINGS", "",
    `Account: #${user?.accountReference ?? "—"}`,
    "",
    `Notifications: ${settings?.notificationsEnabled ? "ON" : "OFF"}`,
    `Execution updates: ${settings?.executionNotifications ? "ON" : "OFF"}`,
    `Deposit updates: ${settings?.depositNotifications ? "ON" : "OFF"}`,
    `Withdrawal updates: ${settings?.withdrawalNotifications ? "ON" : "OFF"}`,
    "",
    "Supported deposits: SOL on Solana, USDT on BSC.",
    "Withdrawals require review and secure signing infrastructure.",
  ].join("\n");
  const keyboard = new InlineKeyboard()
    .text(settings?.notificationsEnabled ? "Disable notifications" : "Enable notifications", "settings:notifications")
    .row()
    .text("Supported networks", "settings:networks")
    .row();
  await renderScreen(ctx, text, withBack(keyboard, "menu:main"));
}

export async function toggleNotificationsHandler(ctx: BotContext) {
  const userId = ctx.session.userId!;
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  await db.update(userSettings).set({
    notificationsEnabled: !(settings?.notificationsEnabled ?? true),
    updatedAt: new Date(),
  }).where(eq(userSettings.userId, userId));
  await settingsHandler(ctx);
}

export async function supportedNetworksHandler(ctx: BotContext) {
  await renderScreen(ctx, [
    "NETWORKS & ASSETS", "",
    "SOLANA",
    "• SOL — native Solana asset",
    "",
    "BSC",
    "• USDT — exact configured BEP20 contract",
    "",
    "Always verify the network before sending funds.",
  ].join("\n"), withBack(new InlineKeyboard(), "menu:settings"));
}

export async function learnMoreHandler(ctx: BotContext) {
  await renderScreen(ctx, [
    "ℹ️ ABOUT AGAMEMNON", "",
    "Agamemnon is a Telegram trading terminal.",
    "",
    "Balances are backed by a PostgreSQL ledger. Deposits are confirmed from blockchain data. Trading requests cross the TradingEngineAdapter boundary.",
    "",
    "The bot never asks for private keys or seed phrases.",
  ].join("\n"), withBack(new InlineKeyboard(), "menu:main"));
}