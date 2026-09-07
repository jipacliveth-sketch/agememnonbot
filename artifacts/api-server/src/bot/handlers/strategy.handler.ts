import { InlineKeyboard } from "grammy";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { strategies, strategyExecutions, wallets } from "../../db/schema";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderMediaScreen, renderScreen } from "../lib/screen";
import { startPlatformStrategy, stopPlatformStrategy } from "../../services/trading.service";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { getMarket } from "../../services/market-data.service";
import { discoverSolanaTokens } from "../../services/token-discovery.service";
import { scanSolanaMarkets } from "../../services/market-scanner.service";

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
  await renderMediaScreen(ctx, "🚀 TRADE", tradeKeyboard());
}

export async function tradeNetworkHandler(ctx: BotContext, network: "SOLANA" | "BSC") {
  setTradeFlow(ctx, TRADE_STEPS.SELECTING_TOKEN, { network });
  const keyboard = new InlineKeyboard();
  if (network === "BSC") {
    await renderScreen(ctx, "BEP20 BNB\n\nNo executable BSC token strategy is configured in the trading engine yet.", withBack(keyboard, "menu:trade"));
    return;
  }
  try {
    const tokens = await discoverSolanaTokens("all", 10);
    for (const token of tokens) keyboard.text(`${token.name} (${token.symbol})`, `trade:token:${token.id}`).row();
    const text = tokens.length
      ? ["SOLANA · LIVE TOKEN DISCOVERY", "", ...tokens.map(formatTokenLine), "", "Select a real market to view details."] .join("\n")
      : "SOLANA\n\nNo live Solana markets qualified for display right now.";
    await renderScreen(ctx, text, withBack(keyboard, "menu:trade"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Solana market provider is unavailable.";
    await renderScreen(ctx, ["SOLANA MARKET DISCOVERY FAILED", "", message, "", "No token data was fabricated."].join("\n"), new InlineKeyboard().text("Retry", "trade:network:SOLANA").row().text("Back", "menu:trade"));
  }
}

export async function tradeTokenHandler(ctx: BotContext, marketId: string) {
  setTradeFlow(ctx, TRADE_STEPS.VIEWING_TOKEN, { network: "SOLANA", marketId });
  let strategiesForToken;
  let market;
  try {
    [strategiesForToken, market] = await Promise.all([
      db.query.strategies.findMany({
        where: and(eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true), eq(strategies.network, "SOLANA")),
      }),
      getMarket(marketId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The market provider is unavailable.";
    await renderScreen(ctx, ["TOKEN DATA UNAVAILABLE", "", message, "", "No price or token details were fabricated."].join("\n"), new InlineKeyboard().text("Retry", `trade:token:${marketId}`).row().text("Back", "trade:network:SOLANA"));
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const strategy of strategiesForToken) {
    keyboard.text(`5m · ${strategy.name}`, `strategy:start:${strategy.slug}:${market.id}:5`).row();
    keyboard.text(`10m · ${strategy.name}`, `strategy:start:${strategy.slug}:${market.id}:10`).row();
    keyboard.text(`15m · ${strategy.name}`, `strategy:start:${strategy.slug}:${market.id}:15`).row();
  }
  await renderMediaScreen(ctx, [
    `${market.name} · ${market.symbol}`,
    "",
    `Network: ${market.network}`,
    `Price: $${formatPrice(market.priceUsd)}`,
    `24h: ${formatPercent(market.priceChange24h)}`,
    `Volume: ${formatUsd(market.volume24hUsd)}`,
    `Market cap: ${formatUsd(market.marketCapUsd)}`,
    `Contract: ${market.contractAddress ?? "unavailable"}`,
    "",
    strategiesForToken.length ? "Select an executable strategy:" : "No executable strategy is available.",
  ].join("\n"), withBack(keyboard, "trade:network:SOLANA"), market.imageUrl ?? "token-sol.png");
}

export async function sniperEntryHandler(ctx: BotContext) {
  setTradeFlow(ctx, TRADE_STEPS.SCANNING_SNIPER);
  await renderScreen(ctx, [
    "🎯 SNIPER ENTRY",
    "",
    "Checking the configured market and strategy capabilities...",
  ].join("\n"), withBack(new InlineKeyboard().text("Cancel", "trade:cancel"), "menu:trade"));

  try {
    const candidates = await scanSolanaMarkets("trending", 5);
    const keyboard = new InlineKeyboard().text("Retry Scan", "trade:sniper").row();
    for (const candidate of candidates) keyboard.text(`Select ${candidate.market.symbol}`, `trade:token:${candidate.market.id}`).row();
    keyboard.text("Back", "menu:trade");
    const text = candidates.length
      ? ["⚡ SNIPER SETUPS DETECTED", "", ...candidates.map(formatCandidate), "", "Scores are calculated from live momentum, volume, liquidity proxy, and trend data."] .join("\n")
      : "NO QUALIFYING SETUP\n\nNo live Solana market currently meets the configured momentum and activity filters.";
    setTradeFlow(ctx, candidates.length ? TRADE_STEPS.VIEWING_TOKEN : TRADE_STEPS.ERROR, { reason: candidates.length ? "sniper_results" : "no_qualifying_setup" });
    await renderScreen(ctx, text, keyboard);
    return;
  } catch (error) {
    setTradeFlow(ctx, TRADE_STEPS.ERROR, { reason: "scanner_failed" });
    const message = error instanceof Error ? error.message : "The configured market scanner failed.";
    await renderScreen(ctx, ["🎯 SNIPER ENTRY", "", "Scan failed.", "", message, "", "No candidates or trades were created."].join("\n"), new InlineKeyboard().text("Retry Scan", "trade:sniper").row().text("Back", "menu:trade"));
    return;
  }
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

export async function strategyStartHandler(ctx: BotContext, slug: string, marketId?: string, runtimeMinutes?: 5 | 10 | 15) {
  if (ctx.session.flow?.name === "trade" && ctx.session.flow.step === TRADE_STEPS.STARTING_BOT) {
    const activeMarketId = ctx.session.flow.data.marketId;
    await renderScreen(ctx, "This start request is already being processed.", withBack(new InlineKeyboard(), activeMarketId ? `trade:token:${activeMarketId}` : "menu:trade"));
    return;
  }
  const selectedMarketId = marketId ?? ctx.session.flow?.data.marketId;
  setTradeFlow(ctx, TRADE_STEPS.STARTING_BOT, { strategySlug: slug, ...(selectedMarketId ? { marketId: selectedMarketId } : {}) });
  try {
    const market = selectedMarketId ? await getMarket(selectedMarketId) : null;
    const execution = await startPlatformStrategy(db, ctx.session.userId!, slug, { marketId: selectedMarketId, tokenSymbol: market?.symbol, runtimeMinutes });
    setTradeFlow(ctx, execution?.status === "ACTIVE" ? TRADE_STEPS.ACTIVE : TRADE_STEPS.STARTING_BOT, { strategySlug: slug, executionId: execution?.id ?? "", ...(selectedMarketId ? { marketId: selectedMarketId } : {}) });
    await renderScreen(ctx, [
      "✅ BOT ACTIVATED", "",
      `Status: ${execution?.status ?? "STARTING"}`,
      `The trading engine opened a ${market?.symbol ?? "SOL"} position using the live market price. TP/SL, fees, P&L, and runtime are engine-controlled.`,
    ].join("\n"), withBack(new InlineKeyboard().text("View Positions", "menu:positions"), "menu:trade"));
  } catch (error) {
    setTradeFlow(ctx, TRADE_STEPS.ERROR, { strategySlug: slug, ...(selectedMarketId ? { marketId: selectedMarketId } : {}) });
    const message = error instanceof Error ? error.message : "The trading engine rejected the request.";
    const retryCallback = selectedMarketId ? `strategy:start:${slug}:${selectedMarketId}:${runtimeMinutes ?? 5}` : `strategy:start:${slug}`;
    const backCallback = selectedMarketId ? `trade:token:${selectedMarketId}` : "menu:trade";
    await renderScreen(ctx, ["⚠️ BOT NOT STARTED", "", message, "", "No trade was created. Check the requirement and retry when the dependency is available."].join("\n"), new InlineKeyboard().text("Retry", retryCallback).row().text("Back", backCallback));
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

function formatTokenLine(token: { name: string; symbol: string; priceUsd: number; priceChange24h: number | null; volume24hUsd: number | null }) {
  return `${token.name} (${token.symbol}) · $${formatPrice(token.priceUsd)} · ${formatPercent(token.priceChange24h)} · Vol ${formatUsd(token.volume24hUsd)}`;
}

function formatCandidate(candidate: { market: { name: string; symbol: string; priceUsd: number; priceChange24h: number | null; volume24hUsd: number | null; marketCapUsd: number | null }; score: number; reasons: string[] }) {
  return [`${candidate.market.name} (${candidate.market.symbol}) · SCORE ${candidate.score}`, `Price $${formatPrice(candidate.market.priceUsd)} · ${formatPercent(candidate.market.priceChange24h)} · Vol ${formatUsd(candidate.market.volume24hUsd)}`, ...candidate.reasons.map((reason) => `- ${reason}`)].join("\n");
}

function formatPrice(value: number) { return value < 1 ? value.toPrecision(5) : value.toFixed(2); }
function formatPercent(value: number | null) { return value === null ? "unavailable" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`; }
function formatUsd(value: number | null) { return value === null ? "unavailable" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`; }