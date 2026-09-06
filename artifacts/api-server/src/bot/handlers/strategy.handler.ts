import { InlineKeyboard } from "grammy";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { strategies, strategyExecutions, wallets } from "../../db/schema";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";
import { startPlatformStrategy, stopPlatformStrategy } from "../../services/trading.service";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { sendHelmetVisual } from "../media";

export async function tradeMenuHandler(ctx: BotContext) {
  const available = await db.query.strategies.findMany({
    where: and(eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true)),
  });
  const keyboard = new InlineKeyboard();
  for (const strategy of available) keyboard.text(strategy.name, `strategy:view:${strategy.slug}`).row();
  await renderScreen(ctx, [
    "🚀 TRADE", "",
    available.length ? "Available strategies:" : "No strategies are available right now.",
    "",
    "All starts and stops are routed through the trading engine adapter.",
  ].join("\n"), withBack(keyboard, "menu:main"));
}

export async function strategyDetailHandler(ctx: BotContext, slug: string) {
  const userId = ctx.session.userId!;
  const strategy = await db.query.strategies.findFirst({ where: eq(strategies.slug, slug) });
  if (!strategy || strategy.status !== "AVAILABLE" || !strategy.enabled) {
    await renderScreen(ctx, "This strategy is no longer available.", withBack(new InlineKeyboard(), "menu:trade"));
    return;
  }
  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
  const active = await db.query.strategyExecutions.findFirst({
    where: and(eq(strategyExecutions.userId, userId), eq(strategyExecutions.strategyId, strategy.id), inArray(strategyExecutions.status, ["STARTING", "ACTIVE", "STOPPING"])),
  });
  const text = [
    strategy.name, "",
    strategy.description, "",
    `Network: ${strategy.network}`,
    `Risk: ${strategy.riskLevel}`,
    `Minimum allocation: $${strategy.minimumBalance}`,
    `Available account funds: $${wallet?.availableBalance ?? "0"}`,
    "",
    active ? `Current status: ${active.status}` : "Current status: INACTIVE",
  ].join("\n");
  const keyboard = new InlineKeyboard();
  if (active) keyboard.text("Stop Strategy", `strategy:stop:${active.id}`);
  else keyboard.text("Start Strategy", `strategy:start:${strategy.slug}`);
  keyboard.row().text("Details", `strategy:details:${strategy.slug}`);
  await renderScreen(ctx, text, withBack(keyboard, "menu:trade"));
}

export async function strategyDetailsHandler(ctx: BotContext, slug: string) {
  const strategy = await db.query.strategies.findFirst({ where: eq(strategies.slug, slug) });
  if (!strategy) {
    await renderScreen(ctx, "This strategy is no longer available.", withBack(new InlineKeyboard(), "menu:trade"));
    return;
  }
  await renderScreen(ctx, [
    "STRATEGY REQUIREMENTS", "",
    strategy.name,
    strategy.description, "",
    `Network: ${strategy.network}`,
    `Risk level: ${strategy.riskLevel}`,
    `Minimum balance: $${strategy.minimumBalance}`,
    "",
    "Starting a strategy reserves the allocation before the adapter is called. If the engine rejects the request, the reservation is released.",
  ].join("\n"), withBack(new InlineKeyboard().text("View Strategy", `strategy:view:${strategy.slug}`), "menu:trade"));
}

export async function strategyStartHandler(ctx: BotContext, slug: string) {
  try {
    const execution = await startPlatformStrategy(db, ctx.session.userId!, slug);
    await sendHelmetVisual(ctx, "⚔️ EXECUTION REQUESTED\nThe command center is routing your strategy through the trading engine.");
    await renderScreen(ctx, [
      "✅ STRATEGY START REQUESTED", "",
      `Status: ${execution?.status ?? "STARTING"}`,
      "The trading engine owns execution status and positions.",
    ].join("\n"), withBack(new InlineKeyboard().text("View Positions", "menu:positions"), "menu:trade"));
  } catch (error) {
    throw error;
  }
}

export async function strategyStopHandler(ctx: BotContext, executionId: string) {
  const execution = await stopPlatformStrategy(db, ctx.session.userId!, executionId);
  await renderScreen(ctx, [
    "⏹ STRATEGY STOPPED", "",
    `Status: ${execution.status}`,
    "Reserved funds have been released by the ledger.",
  ].join("\n"), withBack(new InlineKeyboard().text("Trade", "menu:trade"), "menu:main"));
}

export async function activeStrategiesHandler(ctx: BotContext) {
  const executions = await db.query.strategyExecutions.findMany({
    where: and(eq(strategyExecutions.userId, ctx.session.userId!), inArray(strategyExecutions.status, ["STARTING", "ACTIVE", "STOPPING"])),
    limit: 20,
  });
  const engineState = await tradingEngineAdapter.getAccountState(ctx.session.userId!);
  await renderScreen(ctx, [
    "ACTIVE STRATEGIES", "",
    executions.length ? executions.map((item) => `${item.id.slice(0, 8)} · ${item.status} · $${item.allocatedAmount}`).join("\n") : "No active strategies.",
    "",
    `Engine positions: ${engineState.activePositionsCount}`,
    `Engine today P&L: ${engineState.todayPnl}`,
  ].join("\n"), withBack(new InlineKeyboard(), "menu:trade"));
}