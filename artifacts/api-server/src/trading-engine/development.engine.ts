import { randomUUID } from "crypto";
import { getMarket, MarketData } from "../services/market-data.service";
import { logError } from "../lib/logger";
import { AccountTradingState, PnL, Position, StartStrategyRequest, StrategyExecution, Trade, TradingEngine, TradingStrategy } from "./engine.interface";

type PriceSource = (marketId?: string) => Promise<number>;
type MarketSource = (marketId: string) => Promise<MarketData>;

export interface DevelopmentTradingEngineOptions {
  priceSource?: PriceSource;
  marketSource?: MarketSource;
  tickIntervalMs?: number;
  autoStart?: boolean;
  startingPaperBalance?: number;
  feeRate?: number;
  slippageBps?: number;
}

interface StrategyProfile { takeProfit: number; stopLoss: number; runtimeMinutes: 5 | 10 | 15; }
interface ManagedPosition extends Position {
  executionId: string; quantity: number; entryPriceNumber: number; currentPriceNumber: number;
  openedAt: Date; expiresAtValue: number; feeRate: number; slippageBps: number; marketIdValue: string;
}
interface ManagedExecution {
  execution: StrategyExecution; userId: string; strategyId: string; allocatedAmount: number;
  position: ManagedPosition | null; realizedPnl: number; fees: number; trades: Trade[]; paperBalance: number;
  marketId: string; runtimeMinutes: number; takeProfit: number; stopLoss: number; feeRate: number; slippageBps: number;
  tokenSymbol: string;
}

const DEVELOPMENT_STRATEGIES: TradingStrategy[] = [
  { id: "development-meme-sniper", slug: "meme-sniper", name: "🚀 Meme Sniper", description: "Short-horizon momentum entries using live market data.", network: "SOLANA", riskLevel: "HIGH", minimumBalance: "50" },
  { id: "development-solana-sniper", slug: "solana-sniper", name: "⚡ Solana Sniper", description: "Fast breakout entries with tight exit thresholds.", network: "SOLANA", riskLevel: "HIGH", minimumBalance: "50" },
  { id: "development-new-token-hunter", slug: "new-token-hunter", name: "🎯 New Token Hunter", description: "Short momentum windows with moderate risk controls.", network: "SOLANA", riskLevel: "MEDIUM", minimumBalance: "25" },
  { id: "development-trending-token-trader", slug: "trending-token-trader", name: "🔥 Trending Token Trader", description: "Trend-following entries with wider holding windows.", network: "SOLANA", riskLevel: "MEDIUM", minimumBalance: "25" },
];
const STRATEGY_PROFILES: StrategyProfile[] = [
  { takeProfit: 0.004, stopLoss: 0.003, runtimeMinutes: 5 },
  { takeProfit: 0.006, stopLoss: 0.004, runtimeMinutes: 10 },
  { takeProfit: 0.003, stopLoss: 0.0025, runtimeMinutes: 5 },
  { takeProfit: 0.008, stopLoss: 0.005, runtimeMinutes: 15 },
];

export class DevelopmentTradingEngine implements TradingEngine {
  private readonly executions = new Map<string, ManagedExecution>();
  private readonly priceSource: PriceSource;
  private readonly marketSource: MarketSource;
  private readonly tickIntervalMs: number;
  private readonly startingPaperBalance: number;
  private readonly defaultFeeRate: number;
  private readonly defaultSlippageBps: number;
  private readonly paperBalances = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;

  constructor(options: DevelopmentTradingEngineOptions = {}) {
    this.priceSource = options.priceSource ?? (async (marketId = "solana") => (await getMarket(marketId)).priceUsd);
    this.marketSource = options.marketSource ?? getMarket;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.startingPaperBalance = options.startingPaperBalance ?? 1_000;
    this.defaultFeeRate = options.feeRate ?? 0;
    this.defaultSlippageBps = options.slippageBps ?? 0;
    if (options.autoStart !== false) {
      this.timer = setInterval(() => void this.runMarketTick().catch((error) => logError("engine_market_tick_failed", error)), this.tickIntervalMs);
      this.timer.unref();
    }
  }

  async getAvailableStrategies(): Promise<TradingStrategy[]> { return DEVELOPMENT_STRATEGIES.map((strategy) => ({ ...strategy })); }

  async getAccountState(userId: string): Promise<AccountTradingState> {
    await this.refreshUserPrices(userId);
    const executions = this.userExecutions(userId);
    const realized = executions.reduce((sum, managed) => sum + managed.realizedPnl, 0);
    const unrealized = executions.reduce((sum, managed) => sum + this.unrealizedPnl(managed), 0);
    return { userId, activePositionsCount: executions.filter((managed) => managed.position?.status === "OPEN").length, todayPnl: formatAmount(realized + unrealized), paperBalance: formatAmount(this.paperBalances.get(userId) ?? this.startingPaperBalance) };
  }

  async startStrategy(request: StartStrategyRequest): Promise<StrategyExecution> {
    const allocatedAmount = Number(request.allocatedAmount);
    if (!Number.isFinite(allocatedAmount) || allocatedAmount <= 0) throw new Error("A positive strategy allocation is required.");
    if (this.userExecutions(request.userId).some((managed) => managed.strategyId === request.strategyId && managed.execution.status === "ACTIVE")) throw new Error("This strategy is already active for the account.");
    const paperBalance = this.paperBalances.get(request.userId) ?? this.startingPaperBalance;
    if (allocatedAmount > paperBalance) throw new Error("Insufficient paper balance for this bot.");
    const profile = this.profileFor(request.strategyId);
    const marketId = request.marketId ?? "solana";
    const price = await this.priceSource(marketId);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Live market price is unavailable.");
    const executionId = randomUUID();
    const runtimeMinutes = request.runtimeMinutes ?? profile.runtimeMinutes;
    const execution: StrategyExecution = { executionId, engineExecutionRef: `development-${executionId}`, status: "ACTIVE" };
    const managed: ManagedExecution = {
      execution, userId: request.userId, strategyId: request.strategyId, allocatedAmount, position: null,
      realizedPnl: 0, fees: 0, trades: [], paperBalance: paperBalance - allocatedAmount, marketId,
      runtimeMinutes, takeProfit: request.takeProfit ?? profile.takeProfit, stopLoss: request.stopLoss ?? profile.stopLoss,
      feeRate: request.feeRate ?? this.defaultFeeRate, slippageBps: request.slippageBps ?? this.defaultSlippageBps,
      tokenSymbol: request.tokenSymbol ?? "SOL",
    };
    this.paperBalances.set(request.userId, managed.paperBalance);
    this.executions.set(executionId, managed);
    const market = request.tokenSymbol || !request.marketId ? null : await this.marketSource(marketId).catch(() => null);
    managed.tokenSymbol = request.tokenSymbol ?? market?.symbol ?? "SOL";
    this.openPosition(managed, price, managed.tokenSymbol);
    return { ...execution };
  }

  async stopStrategy(executionId: string): Promise<void> {
    const managed = this.executions.get(executionId);
    if (!managed || managed.execution.status !== "ACTIVE") return;
    if (managed.position) this.closePosition(managed, managed.position.currentPriceNumber, "MANUAL");
    managed.execution.status = "STOPPED";
  }

  async getPositions(userId: string): Promise<Position[]> {
    await this.refreshUserPrices(userId);
    return this.userExecutions(userId).map((managed) => managed.position).filter((position): position is ManagedPosition => position?.status === "OPEN").map((position) => this.publicPosition(position));
  }
  async getTradeHistory(userId: string): Promise<Trade[]> { return this.userExecutions(userId).flatMap((managed) => managed.trades).sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime()).map((trade) => ({ ...trade })); }
  async getPnL(userId: string): Promise<PnL> { await this.refreshUserPrices(userId); const executions = this.userExecutions(userId); return { realized: formatAmount(executions.reduce((sum, managed) => sum + managed.realizedPnl, 0)), unrealized: formatAmount(executions.reduce((sum, managed) => sum + this.unrealizedPnl(managed), 0)) }; }

  async runMarketTick(): Promise<void> {
    if (this.tickInFlight || !this.hasActiveExecutions()) return;
    this.tickInFlight = true;
    try {
      const active = [...this.executions.values()].filter((managed) => managed.execution.status === "ACTIVE" && managed.position);
      await Promise.all(active.map(async (managed) => {
        const price = await this.priceSource(managed.marketId).catch(() => null);
        if (price === null || !Number.isFinite(price) || price <= 0 || !managed.position) return;
        managed.position.currentPriceNumber = price;
        const returnRate = (price - managed.position.entryPriceNumber) / managed.position.entryPriceNumber;
        const expired = Date.now() >= managed.position.expiresAtValue;
        const reason = returnRate >= managed.takeProfit ? "TAKE_PROFIT" : returnRate <= -managed.stopLoss ? "STOP_LOSS" : expired ? "RUNTIME_EXPIRED" : null;
        if (reason) {
          this.closePosition(managed, price, reason);
          if (reason !== "RUNTIME_EXPIRED" && managed.execution.status === "ACTIVE") this.openPosition(managed, price, managed.tokenSymbol);
        }
      }));
    } finally { this.tickInFlight = false; }
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private openPosition(managed: ManagedExecution, price: number, symbol: string) {
    const entryPrice = price * (1 + managed.slippageBps / 100_000);
    const quantity = managed.allocatedAmount / entryPrice;
    const now = new Date();
    const position: ManagedPosition = {
      id: randomUUID(), executionId: managed.execution.executionId, tokenSymbol: symbol, entryPrice: formatAmount(entryPrice), amount: formatAmount(quantity), status: "OPEN", realizedPnl: null,
      quantity, entryPriceNumber: entryPrice, currentPriceNumber: price, openedAt: now, expiresAtValue: now.getTime() + managed.runtimeMinutes * 60_000,
      feeRate: managed.feeRate, slippageBps: managed.slippageBps, marketIdValue: managed.marketId, takeProfit: formatPercent(managed.takeProfit), stopLoss: formatPercent(managed.stopLoss), expiresAt: new Date(now.getTime() + managed.runtimeMinutes * 60_000), marketId: managed.marketId,
    };
    managed.position = position;
    const fee = managed.allocatedAmount * managed.feeRate;
    managed.fees += fee;
    managed.trades.push({ id: randomUUID(), side: "BUY", amount: formatAmount(quantity), price: formatAmount(entryPrice), fee: formatAmount(fee), slippage: formatAmount(entryPrice - price), executedAt: now });
  }

  private closePosition(managed: ManagedExecution, price: number, reason: string) {
    const position = managed.position;
    if (!position || position.status !== "OPEN") return;
    const exitPrice = price * (1 - managed.slippageBps / 100_000);
    const grossPnl = position.quantity * (exitPrice - position.entryPriceNumber);
    const fee = position.quantity * exitPrice * managed.feeRate;
    const netPnl = grossPnl - fee - managed.allocatedAmount * managed.feeRate;
    managed.realizedPnl += netPnl;
    managed.fees += fee;
    position.realizedPnl = formatAmount(netPnl);
    position.status = "CLOSED";
    managed.paperBalance += managed.allocatedAmount + netPnl;
    this.paperBalances.set(managed.userId, managed.paperBalance);
    managed.trades.push({ id: randomUUID(), side: "SELL", amount: formatAmount(position.quantity), price: formatAmount(exitPrice), fee: formatAmount(fee), slippage: formatAmount(price - exitPrice), executedAt: new Date() });
    managed.position = null;
    if (reason === "RUNTIME_EXPIRED") managed.execution.status = "STOPPED";
  }

  private unrealizedPnl(managed: ManagedExecution) { const position = managed.position; return position?.status === "OPEN" ? position.quantity * (position.currentPriceNumber - position.entryPriceNumber) : 0; }
  private async refreshUserPrices(userId: string) { await Promise.all(this.userExecutions(userId).filter((managed) => managed.position?.status === "OPEN").map(async (managed) => { const price = await this.priceSource(managed.marketId).catch(() => null); if (price !== null && managed.position) managed.position.currentPriceNumber = price; })); }
  private userExecutions(userId: string) { return [...this.executions.values()].filter((managed) => managed.userId === userId); }
  private hasActiveExecutions() { return [...this.executions.values()].some((managed) => managed.execution.status === "ACTIVE" && managed.position); }
  private profileFor(strategyId: string) { let hash = 0; for (const char of strategyId) hash = (hash * 31 + char.charCodeAt(0)) | 0; return STRATEGY_PROFILES[Math.abs(hash) % STRATEGY_PROFILES.length]; }
  private publicPosition(position: ManagedPosition): Position { return { id: position.id, tokenSymbol: position.tokenSymbol, entryPrice: position.entryPrice, amount: position.amount, status: position.status, realizedPnl: position.realizedPnl, currentPrice: formatAmount(position.currentPriceNumber), unrealizedPnl: formatAmount(position.quantity * (position.currentPriceNumber - position.entryPriceNumber)), takeProfit: position.takeProfit, stopLoss: position.stopLoss, expiresAt: position.expiresAt, marketId: position.marketIdValue }; }
}

function formatAmount(value: number) { return value.toFixed(8); }
function formatPercent(value: number) { return `${(value * 100).toFixed(3)}%`; }
