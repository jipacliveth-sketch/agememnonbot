import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { db } from "../../db/client";
import { wallets } from "../../db/schema";
import { eq } from "drizzle-orm";
import { mainMenuKeyboard } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";
import { getWalletBalances } from "../../services/ledger.service";
import { sendOnboardingAnimation, sendWelcomeVisual } from "../media";

export async function startHandler(ctx: BotContext) {
  const isNewAccount = (ctx as any).isNewAccount as boolean;
  const userId = ctx.session.userId!;

  if (isNewAccount) {
    await sendWelcomeVisual(ctx);
    await sendOnboardingAnimation(ctx);
    const text = [
      "⚔️ WELCOME TO AGAMEMNON",
      "",
      "Your memecoin trading command center.",
      "",
      "Trade selected memecoin markets using automated strategies,",
      "monitor your positions and manage your trading wallet",
      "directly from Telegram.",
      "",
    ].join("\n");

    const keyboard = new InlineKeyboard().text("🚀 Get Started", "menu:main").text("ℹ️ Learn More", "menu:learn_more");

    await renderScreen(ctx, text, keyboard);
    return;
  }

  const [wallet, balances] = await Promise.all([
    db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }),
    getWalletBalances(db, userId),
  ]);
  const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? "back";

  const text = [
    `Welcome back, ${username}.`,
    "",
    "Your trading account is ready.",
    "",
    balances.length
      ? `Balances: ${balances.map((balance) => `${balance.asset} ${balance.availableBalance}`).join(", ")}`
      : `Balance: $${wallet?.availableBalance ?? "0"}`,
    "",
    "What would you like to do?",
  ].join("\n");

  await renderScreen(ctx, text, mainMenuKeyboard());
}
