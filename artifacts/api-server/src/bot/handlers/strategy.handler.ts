import { InlineKeyboard } from "grammy";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { strategies, strategyExecutions, wallets } from "../../db/schema";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderMediaScreen, renderScreen } from "../lib/screen";
import { startPlatformStrategy, stopPlatformStrategy } from "../../services/trading.service";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { getUsdPrice } from "../../services/market-data.service";

const TRADE_STEPS = {
  SELECTING_NETWORK: "SELECTING_NETWORK",
  SELECTING_TOKEN: "SELECTING_TOKEN",
  VIEWING_TOKEN: "VIEWING_TOKEN",
  SCANNING_SNIPER: "SCANNING_SNIPER",
  STARTING_BOT: "STARTING_BOT",
  ACTIVE: "ACTIVE",
  ERROR: "ERROR",
  CANCELLED: "CANCELLED",
} as const;

function setTradeFlow(ctx: BotContext, step: string, data: Record<string, string> = {}) {
  ctx.session.flow = { name: "trade", step, data };
}

function tradeKeyboard() {
  return new InlineKeyboard()
    .text("Solana", "trade:network:SOLANA")
    .text("BEP20 BNB", "trade:network:BSC")
    .row()
    .text("Sniper Entry", "trade:sniper")
    .row()
    .text("Cancel", "trade:cancel");
}

export async function tradeMenuHandler(ctx: BotContext) {
  setTradeFlow(ctx, TRADE_STEPS.SELECTING_NETWORK);
  await renderMediaScreen(ctx, [
    "🚀 TRADE",
    "",
    "Paper execution only. Choose a supported network to inspect executable strategies and live market data.",
  ].join("\n"), tradeKeyboard());
}

export async function tradeNetworkHandler(ctx: BotContext, network: "SOLANA" | "BSC") {
  setTradeFlow(ctx, TRADE_STEPS.SELECTING_TOKEN, { network });
  const available = await db.query.strategies.findMany({
    where: and(eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true), eq(strategies.network, network)),
  });
  const keyboard = new InlineKeyboard();
  if (network === "SOLANA" && available.length) keyboard.text("SOL · Live market", "trade:token:SOL").row();
  const text = network === "BSC"
    ? "BEP20 BNB\n\nNo executable BSC token strategy is configured in the trading engine yet."
    : available.length
      ? "SOLANA\n\nThe current engine exposes SOL as its verified executable market. Select it to inspect live data."
      : "SOLANA\n\nNo executable strategy is currently configured for this network.";
  await renderScreen(ctx, text, withBack(keyboard, "menu:trade"));
}

export async function tradeTokenHandler(ctx: BotContext, token: "SOL") {
  setTradeFlow(ctx, TRADE_STEPS.VIEWING_TOKEN, { network: "SOLANA", token });
  const [strategiesForToken, quote] = await Promise.all([
    db.query.strategies.findMany({
      where: and(eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true), eq(strategies.network, "SOLANA")),
    }),
    getUsdPrice(token).catch(() => null),
  ]);
  const keyboard = new InlineKeyboard();
  for (const strategy of strategiesForToken) keyboard.text(`Start ${strategy.name}`, `strategy:start:${strategy.slug}`).row();
  const priceLine = quote
    ? `Live ${quote.symbol} price: $${quote.usdPrice.toFixed(2)}${quote.usd24hChange === null ? "" : ` (${quote.usd24hChange >= 0 ? "+" : ""}${quote.usd24hChange.toFixed(2)}% 24h)`}`
    : "Live SOL price is currently unavailable.";
  await renderMediaScreen(ctx, [
    "SOL · SOLANA",
    "",
    priceLine,
    "",
    "The engine opens a paper position from the verified live quote, then monitors it for configured exits.",
    "",
    strategiesForToken.length ? "Select an executable strategy:" : "No executable strategy is available.",
  ].join("\n"), withBack(keyboard, "trade:network:SOLANA"), "token-sol.png");
}

export async function sniperEntryHandler(ctx: BotContext) {
  setTradeFlow(ctx, TRADE_STEPS.SCANNING_SNIPER);
  await renderScreen(ctx, [
    "🎯 SNIPER ENTRY",
    "",
    "Checking the configured market and strategy capabilities...",
  ].join("\n"), withBack(new InlineKeyboard().text("Cancel", "trade:cancel"), "menu:trade"));

  let strategies;
  try {
    strategies = await tradingEngineAdapter.getAvailableStrategies();
  } catch (error) {
    setTradeFlow(ctx, TRADE_STEPS.ERROR, { reason: "scanner_failed" });
    const message = error instanceof Error ? error.message : "The configured market scanner failed.";
    await renderScreen(ctx, ["🎯 SNIPER ENTRY", "", "Scan failed.", "", message, "", "No candidates or trades were created."].join("\n"), new InlineKeyboard().text("Retry Scan", "trade:sniper").row().text("Back", "menu:trade"));
    return;
  }
  const keyboard = new InlineKeyboard().text("Retry Scan", "trade:sniper").row().text("Back", "menu:trade");
  const text = strategies.length
    ? [
      "🎯 SNIPER ENTRY",
      "",
      "No candidate ranking was produced.",
      "",
      "The connected engine exposes strategy metadata and live SOL execution, but no market-wide token scanner or volume/liquidity feed. No token is being recommended.",
    ].join("\n")
    : [
      "🎯 SNIPER ENTRY",
      "",
      "Scan unavailable.",
      "",
      "The trading engine does not currently expose a market scanner. No candidates, scores, prices, or trades were fabricated.",
    ].join("\n");
  setTradeFlow(ctx, TRADE_STEPS.ERROR, { reason: "scanner_unavailable" });
  await renderScreen(ctx, text, keyboard);
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
  if (ctx.session.flow?.name === "trade" && ctx.session.flow.step === TRADE_STEPS.STARTING_BOT) {
    await renderScreen(ctx, "This start request is already being processed.", withBack(new InlineKeyboard(), "trade:token:SOL"));
    return;
  }
  setTradeFlow(ctx, TRADE_STEPS.STARTING_BOT, { strategySlug: slug });
  try {
    const execution = await startPlatformStrategy(db, ctx.session.userId!, slug);
    setTradeFlow(ctx, execution?.status === "ACTIVE" ? TRADE_STEPS.ACTIVE : TRADE_STEPS.STARTING_BOT, { strategySlug: slug });
    await renderScreen(ctx, [
      "✅ PAPER BOT ACTIVATED", "",
      `Status: ${execution?.status ?? "STARTING"}`,
      "The trading engine opened and owns this paper execution using live market data. Positions, exits, and P&L come from the engine.",
    ].join("\n"), withBack(new InlineKeyboard().text("View Positions", "menu:positions"), "menu:trade"));
  } catch (error) {
    setTradeFlow(ctx, TRADE_STEPS.ERROR, { strategySlug: slug });
    const message = error instanceof Error ? error.message : "The trading engine rejected the request.";
    await renderScreen(ctx, ["⚠️ PAPER BOT NOT STARTED", "", message, "", "No trade was created. Check the requirement and retry when the dependency is available."].join("\n"), new InlineKeyboard().text("Retry", `strategy:start:${slug}`).row().text("Back", "trade:token:SOL"));
  }
}

export async function tradeCancelHandler(ctx: BotContext) {
  ctx.session.flow = { name: "trade", step: TRADE_STEPS.CANCELLED, data: {} };
  await renderScreen(ctx, "Trade workflow cancelled. No order or strategy execution was created.", withBack(new InlineKeyboard(), "menu:main"));
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