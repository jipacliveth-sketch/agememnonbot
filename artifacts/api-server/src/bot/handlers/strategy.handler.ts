import { InlineKeyboard } from "grammy";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { strategies, strategyExecutions, wallets, simulationSessions } from "../../db/schema";
import { BotContext } from "../context";
import { withBack } from "../keyboards/navigation";
import { renderMediaScreen, renderScreen } from "../lib/screen";
import { startPlatformStrategy, stopPlatformStrategy } from "../../services/trading.service";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { getMarket } from "../../services/market-data.service";
import { discoverSolanaTokens } from "../../services/token-discovery.service";
import { scanSolanaMarkets } from "../../services/market-scanner.service";
import { getWalletBalances } from "../../services/ledger.service";
import { chooseMemeToken, SIMULATION_CONFIG, SNIPER_MEME_TOKENS, TRADE_MEME_TOKENS } from "../../config/simulation";
import { calculatePositionSize, calculateTradeResult, capPositivePnl, completeSimulation, createSimulation, formatCooldown, getActiveSimulation, recordSimulationTrade, stopSimulation } from "../../services/simulation.service";
import { log, logError } from "../../lib/logger";

const activeWorkflows = new Map<string, Promise<void>>();

function startWorkflow(userId: string, operation: string, task: () => Promise<void>) {
  if (activeWorkflows.has(userId)) return false;
  const startedAt = Date.now();
  const work = task().catch((error) => logError("trade_workflow_failed", error, { userId, operation })).finally(() => {
    log("info", "trade_workflow_complete", { userId, operation, durationMs: Date.now() - startedAt });
    if (activeWorkflows.get(userId) === work) activeWorkflows.delete(userId);
  });
  activeWorkflows.set(userId, work);
  return true;
}

function logDuration(operation: string, startedAt: number, fields: Record<string, unknown> = {}) {
  log("info", "trade_latency", { operation, durationMs: Date.now() - startedAt, ...fields });
}

const TRADE_STEPS = {
  MENU: "MENU",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  SCANNING_SNIPER: "SCANNING_SNIPER",
  SNIPER_RUNNING: "SNIPER_RUNNING",
  COMPLETE: "COMPLETE",
  SELECTING_NETWORK: "SELECTING_NETWORK",
  SELECTING_TOKEN: "SELECTING_TOKEN",
  VIEWING_TOKEN: "VIEWING_TOKEN",
  STARTING_BOT: "STARTING_BOT",
  ACTIVE: "ACTIVE",
  ERROR: "ERROR",
  CANCELLED: "CANCELLED",
} as const;

function setTradeFlow(ctx: BotContext, step: string, data: Record<string, string> = {}) {
  ctx.session.flow = { name: "trade", step, data };
}

function tradeKeyboard() {
  return new InlineKeyboard().text("START BOT", "trade:start").row().text("SNIPER ENTRY", "trade:sniper").row().text("BACK", "menu:main");
}

export async function tradeMenuHandler(ctx: BotContext) {
  setTradeFlow(ctx, TRADE_STEPS.MENU);
  const startedAt = Date.now();
  await renderMediaScreen(ctx, "⚡ TRADE BOT", tradeKeyboard());
  logDuration("trade_button_initial", startedAt);
  const userId = ctx.session.userId!;
  void (async () => {
    const startedAt = Date.now();
    try {
      const active = await getActiveSimulation(db, userId, "TRADE");
      logDuration("trade_menu_status", startedAt, { active: Boolean(active) });
      if (active && ctx.session.flow?.step === TRADE_STEPS.MENU) {
        setTradeFlow(ctx, TRADE_STEPS.RUNNING, { sessionId: active.id });
        await renderMediaScreen(ctx, formatSimulation(active), new InlineKeyboard().text("STOP BOT", "trade:cancel").row().text("BACK", "menu:main"));
      }
    } catch (error) {
      logError("trade_menu_status_failed", error, { userId });
    }
  });
}

export async function tradeStartHandler(ctx: BotContext) {
  if (ctx.session.flow?.step === TRADE_STEPS.STARTING || ctx.session.flow?.step === TRADE_STEPS.RUNNING) return;
  setTradeFlow(ctx, TRADE_STEPS.STARTING);
  const startedAt = Date.now();
  await renderMediaScreen(ctx, "🤖 BOT STARTING...", new InlineKeyboard().text("STOP BOT", "trade:cancel"));
  logDuration("start_bot_initial", startedAt);
  startWorkflow(ctx.session.userId!, "trade_simulation", () => runSimulation(ctx, "TRADE", startedAt));
}

export async function tradeNetworkHandler(ctx: BotContext, network: "SOLANA" | "BSC") {
  setTradeFlow(ctx, TRADE_STEPS.SELECTING_TOKEN, { network });
  const keyboard = new InlineKeyboard();
  if (network === "BSC") {
    await renderScreen(ctx, "BEP20 BNB\n\nNo executable BSC token strategy is configured in the trading engine yet.", withBack(keyboard, "menu:trade"));
    return;
  }
  const startedAt = Date.now();
  await renderScreen(ctx, "SOLANA\n\nSCANNING LIVE MARKETS...", withBack(keyboard, "menu:trade"));
  logDuration("token_selection_initial", startedAt);
  startWorkflow(ctx.session.userId!, "token_discovery", async () => {
   const startedAt = Date.now();
   try {
    const tokens = await discoverSolanaTokens("all", 10);
    logDuration("token_discovery", startedAt, { count: tokens.length });
    for (const token of tokens) keyboard.text(`${token.name} (${token.symbol})`, `trade:token:${token.id}`).row();
    const text = tokens.length
      ? ["SOLANA · LIVE TOKEN DISCOVERY", "", ...tokens.map(formatTokenLine), "", "Select a real market to view details."] .join("\n")
      : "SOLANA\n\nNo live Solana markets qualified for display right now.";
    await renderScreen(ctx, text, withBack(keyboard, "menu:trade"));
  } catch (error) {
    logDuration("token_discovery", startedAt, { failed: true });
    const message = error instanceof Error ? error.message : "The Solana market provider is unavailable.";
    await renderScreen(ctx, ["SOLANA MARKET DISCOVERY FAILED", "", message, "", "No token data was fabricated."].join("\n"), new InlineKeyboard().text("Retry", "trade:network:SOLANA").row().text("Back", "menu:trade"));
  }
  });
}

export async function tradeTokenHandler(ctx: BotContext, marketId: string) {
  setTradeFlow(ctx, TRADE_STEPS.VIEWING_TOKEN, { network: "SOLANA", marketId });
  const startedAt = Date.now();
  await renderScreen(ctx, "TOKEN\n\nLOADING MARKET DETAILS...", withBack(new InlineKeyboard(), "trade:network:SOLANA"));
  logDuration("token_details_initial", startedAt, { marketId });
  startWorkflow(ctx.session.userId!, "token_details", async () => {
   const startedAt = Date.now();
  let strategiesForToken;
  let market;
  try {
    [strategiesForToken, market] = await Promise.all([
      db.query.strategies.findMany({
        where: and(eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true), eq(strategies.network, "SOLANA")),
      }),
      getMarket(marketId),
    ]);
    logDuration("token_details", startedAt, { marketId });
  } catch (error) {
    logDuration("token_details", startedAt, { marketId, failed: true });
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
  });
}

export async function sniperEntryHandler(ctx: BotContext) {
  if (ctx.session.flow?.step === TRADE_STEPS.SCANNING_SNIPER || ctx.session.flow?.step === TRADE_STEPS.SNIPER_RUNNING) return;
  setTradeFlow(ctx, TRADE_STEPS.SCANNING_SNIPER);
  const startedAt = Date.now();
  await renderMediaScreen(ctx, "🔎 ANALYZING MARKET", new InlineKeyboard().text("BACK", "menu:trade"));
  logDuration("sniper_entry_initial", startedAt);
  startWorkflow(ctx.session.userId!, "sniper_simulation", () => runSimulation(ctx, "SNIPER", startedAt));
}

async function runSimulation(ctx: BotContext, type: "TRADE" | "SNIPER", interactionStartedAt: number) {
  try {
    const universe = type === "TRADE" ? TRADE_MEME_TOKENS : SNIPER_MEME_TOKENS;
    const token = chooseMemeToken(universe);
    const startedAt = Date.now();
    const [market, wallet] = await Promise.all([
      getMarket(token.marketId),
      db.query.wallets.findFirst({ where: eq(wallets.userId, ctx.session.userId!) }),
    ]);
    logDuration("simulation_prerequisites", startedAt, { type, marketId: token.marketId });
    if (market.symbol !== token.symbol) throw new Error(`Configured ${token.symbol} market resolved as ${market.symbol}.`);
    const balance = Number(wallet?.availableBalance ?? 0);
    const positionSize = type === "SNIPER" ? calculatePositionSize(balance).amount : balance * 0.2;
    const created = await createSimulation(db, ctx.session.userId!, type, { ...market, marketId: market.id }, type === "SNIPER" ? SIMULATION_CONFIG.sniperRuntimeMs : SIMULATION_CONFIG.tradeRuntimeMs, positionSize);
    if (!created.created) return;
    const session = created.session;
    if (type === "SNIPER") await renderMediaScreen(ctx, `⚡ SNIPER TARGET FOUND\n\nToken: $${session.tokenSymbol}\nEntry: $${formatPrice(Number(session.entryPrice))}`, new InlineKeyboard().text("STOP BOT", "trade:cancel"));
    else await renderMediaScreen(ctx, `🟢 BOT RUNNING\n\nTOKEN SELECTED\n${session.tokenSymbol}\n\nEntry: $${formatPrice(Number(session.entryPrice))}`, new InlineKeyboard().text("STOP BOT", "trade:cancel"));
    setTradeFlow(ctx, type === "SNIPER" ? TRADE_STEPS.SNIPER_RUNNING : TRADE_STEPS.RUNNING, { sessionId: session.id });
    await monitorSimulation(ctx, session.id, type, interactionStartedAt);
  } catch (error) {
    const cooldown = formatCooldown(error);
    setTradeFlow(ctx, TRADE_STEPS.ERROR, {});
    await renderMediaScreen(ctx, cooldown ? `SNIPER LIMIT REACHED\n\nTry again in ${cooldown}.` : `⚠️ SIMULATION UNAVAILABLE\n\n${error instanceof Error ? error.message : "The market provider is unavailable."}`, new InlineKeyboard().text("RETRY", type === "SNIPER" ? "trade:sniper" : "trade:start").row().text("BACK", "menu:trade"));
  }
}

async function monitorSimulation(ctx: BotContext, sessionId: string, type: "TRADE" | "SNIPER", interactionStartedAt: number) {
  const deadline = Date.now() + (type === "SNIPER" ? SIMULATION_CONFIG.sniperRuntimeMs : SIMULATION_CONFIG.tradeRuntimeMs);
  let completedTrades = 0;
  while (Date.now() < deadline && completedTrades < (type === "SNIPER" ? 1 : 10)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(SIMULATION_CONFIG.updateIntervalMs, Math.max(0, deadline - Date.now()))));
    const session = await db.query.simulationSessions.findFirst({ where: eq(simulationSessions.id, sessionId) });
    if (!session || session.status !== "RUNNING") return;
    const market = await getMarket(session.marketId);
    const current = market.priceUsd;
    const movement = (current - Number(session.entryPrice)) / Number(session.entryPrice);
    const outcome = movement >= 0.04 ? "TAKE_PROFIT" : movement <= -0.025 ? "STOP_LOSS" : "TIMEOUT";
    const result = calculateTradeResult({ entryPrice: Number(session.entryPrice), exitPrice: current, positionSize: Number(session.positionSize), takeProfit: Number(session.takeProfit), stopLoss: Number(session.stopLoss), outcome, maxPositivePnl: Math.max(0, capPositivePnl(Number.POSITIVE_INFINITY, Number(session.startingBalance)) - Number(session.grossPnl)) });
    await recordSimulationTrade(db, sessionId, result, current);
    completedTrades += 1;
    await renderMediaScreen(ctx, formatSimulation({ ...session, currentPrice: String(current), totalTrades: completedTrades, netPnl: String(result.netPnl) }), new InlineKeyboard().text("STOP BOT", "trade:cancel"));
    if (type === "SNIPER") break;
  }
  const completed = await completeSimulation(db, sessionId);
  if (completed) {
    setTradeFlow(ctx, TRADE_STEPS.COMPLETE, { sessionId });
    await renderMediaScreen(ctx, formatCompletion(completed), new InlineKeyboard().text("TRADE AGAIN", "trade:start").text("SNIPER ENTRY", "trade:sniper"));
    logDuration("final_result", interactionStartedAt, { sessionId, type });
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
  await stopSimulation(db, ctx.session.userId!, ctx.session.flow?.data.sessionId);
  ctx.session.flow = { name: "trade", step: TRADE_STEPS.CANCELLED, data: {} };
  await renderMediaScreen(ctx, "⏹ SIMULATION STOPPED\n\nNo real trade was executed.", new InlineKeyboard().text("TRADE", "menu:trade").text("BACK", "menu:main"));
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

function formatSimulation(session: { tokenSymbol: string; entryPrice: string; currentPrice: string; positionSize: string; takeProfit: string; stopLoss: string; netPnl: string; totalTrades: number }) {
  return [
    "🎯 POSITION ACTIVE", "", session.tokenSymbol, "",
    `Entry: $${formatPrice(Number(session.entryPrice))}`,
    `Current: $${formatPrice(Number(session.currentPrice))}`,
    `Position: $${formatPrice(Number(session.positionSize))}`, "",
    `Take Profit: $${formatPrice(Number(session.takeProfit))}`,
    `Stop Loss: $${formatPrice(Number(session.stopLoss))}`, "",
    `P&L: ${Number(session.netPnl) >= 0 ? "+" : "-"}$${Math.abs(Number(session.netPnl)).toFixed(2)}`,
    `Trades: ${session.totalTrades}`,
  ].join("\n");
}

function formatCompletion(session: { tokenSymbol: string; startingBalance: string; endingBalance: string | null; netPnl: string; totalTrades: number; winningTrades: number; losingTrades: number; takeProfits: number; stopLosses: number }) {
  return [
    "✅ TRADE COMPLETE", "", `Token: ${session.tokenSymbol}`,
    `Starting Balance: $${formatPrice(Number(session.startingBalance))}`,
    `Ending Balance: $${formatPrice(Number(session.endingBalance ?? session.startingBalance))}`, "",
    `Total P&L: ${Number(session.netPnl) >= 0 ? "+" : "-"}$${Math.abs(Number(session.netPnl)).toFixed(2)}`, "",
    `Trades: ${session.totalTrades}`, `Won: ${session.winningTrades}`, `Lost: ${session.losingTrades}`, "",
    `Take Profits: ${session.takeProfits}`, `Stop Losses: ${session.stopLosses}`,
  ].join("\n");
}