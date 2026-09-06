import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";
import { tradingEngineAdapter } from "../../trading-engine/adapter";

export async function positionsHandler(ctx: BotContext) {
  const userId = ctx.session.userId!;
  const [positions, pnl] = await Promise.all([
    tradingEngineAdapter.getPositions(userId),
    tradingEngineAdapter.getPnL(userId),
  ]);
  const keyboard = new InlineKeyboard().text("Refresh", "menu:positions").row();
  if (!positions.length) {
    await renderScreen(ctx, [
      "📊 POSITIONS", "",
      "No open positions reported by the trading engine.", "",
      `Realized P&L: ${pnl.realized}`,
      `Unrealized P&L: ${pnl.unrealized}`,
    ].join("\n"), withBack(keyboard, "menu:main"));
    return;
  }
  const lines = positions.map((position) => [
    `${position.tokenSymbol} · ${position.status}`,
    `Entry: ${position.entryPrice}`,
    `Size: ${position.amount}`,
    `Realized P&L: ${position.realizedPnl ?? "—"}`,
  ].join("\n"));
  await renderScreen(ctx, [
    "📊 POSITIONS", "",
    lines.join("\n\n"),
    "",
    `Realized P&L: ${pnl.realized}`,
    `Unrealized P&L: ${pnl.unrealized}`,
  ].join("\n"), withBack(keyboard, "menu:main"));
}