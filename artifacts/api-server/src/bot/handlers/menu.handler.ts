import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { wallets, users } from "../../db/schema";
import { BotContext } from "../context";
import { mainMenuKeyboard } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { getUsdPrice } from "../../services/market-data.service";
import { getWalletBalances } from "../../services/ledger.service";

export async function mainMenuHandler(ctx: BotContext) {
  const userId = ctx.session.userId!;

  const [wallet, user, balances, accountState, solPrice, pnl] = await Promise.all([
    db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }),
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    getWalletBalances(db, userId),
    tradingEngineAdapter.getAccountState(userId),
    getUsdPrice("SOL").catch(() => null), // never fabricate a price — just omit the line if unavailable
    tradingEngineAdapter.getPnL(userId),
  ]);

  const lines = [
    "⚔️ AGAMEMNON — TRADING TERMINAL",
    "",
    `Account: #${user?.accountReference ?? "—"}`,
  ];
  if (solPrice) {
    const changeStr = solPrice.usd24hChange !== null ? formatChange(solPrice.usd24hChange) : "—";
    lines.push(`SOL: $${solPrice.usdPrice.toFixed(2)} (${changeStr})`);
  }
  lines.push(
    "",
    "Asset Balances",
    balances.length ? balances.map((balance) => `${balance.asset}: ${balance.availableBalance} available · ${balance.lockedBalance} locked`).join("\n") : "No deposits yet.",
    "",
    `Account balance: $${wallet?.availableBalance ?? "0"}`,
    `Account locked: $${wallet?.lockedBalance ?? "0"}`,
    "",
    "Active Positions",
    `${accountState.activePositionsCount}`,
    "",
    "Today's P&L",
    pnl.realized,
    "",
    "━━━━━━━━━━━━━━━━",
    "",
    "Choose an action:"
  );
  const text = lines.join("\n");

  await renderScreen(ctx, text, mainMenuKeyboard());
}

function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}% 24h`;
}
