import { randomUUID } from "crypto";
import { getUsdPrice } from "../services/market-data.service";
import { logError } from "../lib/logger";
import {
  AccountTradingState,
  PnL,
  Position,
  StartStrategyRequest,
  StrategyExecution,
  Trade,
  TradingEngine,
  TradingStrategy,
} from "./engine.interface";

type PriceSource = () => Promise<number>;

export interface DevelopmentTradingEngineOptions {
  priceSource?: PriceSource;
  tickIntervalMs?: number;
  autoStart?: boolean;
}

interface StrategyProfile {
  takeProfit: number;
  stopLoss: number;
  maxHoldTicks: number;
}

interface ManagedPosition extends Position {
  executionId: string;
  quantity: number;
  entryPriceNumber: number;
  openedAt: Date;
  holdTicks: number;
}

interface ManagedExecution {
  execution: StrategyExecution;
  userId: string;
  strategyId: string;
  allocatedAmount: number;
  position: ManagedPosition | null;
  realizedPnl: number;
  trades: Trade[];
}

const DEVELOPMENT_STRATEGIES: TradingStrategy[] = [
  {
    id: "development-meme-sniper",
    slug: "meme-sniper",
    name: "🚀 Meme Sniper",
    description: "Short-horizon momentum entries using live SOL market data.",
    network: "SOLANA",
    riskLevel: "HIGH",
    minimumBalance: "50",
  },
  {
    id: "development-solana-sniper",
    slug: "solana-sniper",
    name: "⚡ Solana Sniper",
    description: "Fast breakout entries with tight exit thresholds.",
    network: "SOLANA",
    riskLevel: "HIGH",
    minimumBalance: "50",
  },
  {
    id: "development-new-token-hunter",
    slug: "new-token-hunter",
    name: "🎯 New Token Hunter",
    description: "Short momentum windows with moderate risk controls.",
    network: "SOLANA",
    riskLevel: "MEDIUM",
    minimumBalance: "25",
  },
  {
    id: "development-trending-token-trader",
    slug: "trending-token-trader",
    name: "🔥 Trending Token Trader",
    description: "Trend-following entries with wider holding windows.",
    network: "SOLANA",
    riskLevel: "MEDIUM",
    minimumBalance: "25",
  },
];

const STRATEGY_PROFILES: StrategyProfile[] = [
  { takeProfit: 0.004, stopLoss: 0.003, maxHoldTicks: 6 },
  { takeProfit: 0.006, stopLoss: 0.004, maxHoldTicks: 8 },
  { takeProfit: 0.003, stopLoss: 0.0025, maxHoldTicks: 5 },
  { takeProfit: 0.008, stopLoss: 0.005, maxHoldTicks: 10 },
];

/**
 * Built-in verification engine that runs the complete strategy lifecycle against live
 * SOL/USD quotes while keeping its positions and P&L inside the engine.
 *
 * The adapter is the only application boundary needed to replace this with
 * an execution-backed engine later. Wallet and ledger services are not
 * touched by this implementation.
 */
export class DevelopmentTradingEngine implements TradingEngine {
  private readonly executions = new Map<string, ManagedExecution>();
  private readonly priceSource: PriceSource;
  private readonly tickIntervalMs: number;
  private lastPrice: number | null = null;
  private tickInFlight = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: DevelopmentTradingEngineOptions = {}) {
    this.priceSource = options.priceSource ?? (async () => (await getUsdPrice("SOL")).usdPrice);
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;

    if (options.autoStart !== false) {
      this.timer = setInterval(() => {
        void this.runMarketTick().catch((error) => {
          logError("engine_market_tick_failed", error);
        });
      }, this.tickIntervalMs);
      this.timer.unref();
    }
  }

  async getAvailableStrategies(): Promise<TradingStrategy[]> {
    return DEVELOPMENT_STRATEGIES.map((strategy) => ({ ...strategy }));
  }

  async getAccountState(userId: string): Promise<AccountTradingState> {
    await this.refreshPrice();
    const executions = this.userExecutions(userId);
    const unrealized = executions.reduce((sum, managed) => sum + this.unrealizedPnl(managed), 0);
    const realized = executions.reduce((sum, managed) => sum + managed.realizedPnl, 0);

    return {
      userId,
      activePositionsCount: executions.filter((managed) => managed.position?.status === "OPEN").length,
      todayPnl: formatAmount(realized + unrealized),
    };
  }

  async startStrategy(request: StartStrategyRequest): Promise<StrategyExecution> {
    const allocatedAmount = Number(request.allocatedAmount);
    if (!Number.isFinite(allocatedAmount) || allocatedAmount <= 0) {
      throw new Error("A positive strategy allocation is required.");
    }

    const existing = this.userExecutions(request.userId).find(
      (managed) => managed.strategyId === request.strategyId && managed.execution.status === "ACTIVE"
    );
    if (existing) {
      throw new Error("This strategy is already active for the account.");
    }

    const price = await this.refreshPrice();
    const executionId = randomUUID();
    const execution: StrategyExecution = {
      executionId,
      engineExecutionRef: `development-${executionId}`,
      status: "ACTIVE",
    };
    const managed: ManagedExecution = {
      execution,
      userId: request.userId,
      strategyId: request.strategyId,
      allocatedAmount,
      position: null,
      realizedPnl: 0,
      trades: [],
    };

    this.executions.set(executionId, managed);
    this.openPosition(managed, price);
    return { ...execution };
  }

  async stopStrategy(executionId: string): Promise<void> {
    const managed = this.executions.get(executionId);
    if (!managed || managed.execution.status !== "ACTIVE") return;

    if (managed.position) {
      this.closePosition(managed, this.lastPrice ?? managed.position.entryPriceNumber);
    }
    managed.execution.status = "STOPPED";
  }

  async getPositions(userId: string): Promise<Position[]> {
    await this.refreshPrice();
    return this.userExecutions(userId)
      .map((managed) => managed.position)
      .filter((position): position is ManagedPosition => position?.status === "OPEN")
      .map((position) => this.publicPosition(position));
  }

  async getTradeHistory(userId: string): Promise<Trade[]> {
    return this.userExecutions(userId)
      .flatMap((managed) => managed.trades)
      .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime())
      .map((trade) => ({ ...trade }));
  }

  async getPnL(userId: string): Promise<PnL> {
    await this.refreshPrice();
    const executions = this.userExecutions(userId);
    return {
      realized: formatAmount(executions.reduce((sum, managed) => sum + managed.realizedPnl, 0)),
      unrealized: formatAmount(executions.reduce((sum, managed) => sum + this.unrealizedPnl(managed), 0)),
    };
  }

  /**
   * Runs one autonomous market cycle. It is public for deterministic runtime
   * verification; production scheduling is provided by the interval above.
   */
  async runMarketTick(): Promise<void> {
    if (this.tickInFlight || !this.hasActiveExecutions()) return;

    this.tickInFlight = true;
    try {
      const price = await this.refreshPrice();
      for (const managed of this.executions.values()) {
        if (managed.execution.status !== "ACTIVE" || !managed.position) continue;

        managed.position.holdTicks += 1;
        const profile = this.profileFor(managed.strategyId);
        const returnRate = (price - managed.position.entryPriceNumber) / managed.position.entryPriceNumber;
        const shouldClose =
          returnRate >= profile.takeProfit ||
          returnRate <= -profile.stopLoss ||
          managed.position.holdTicks >= profile.maxHoldTicks;

        if (shouldClose) {
          this.closePosition(managed, price);
          if (managed.execution.status === "ACTIVE") this.openPosition(managed, price);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refreshPrice(): Promise<number> {
    try {
      const price = await this.priceSource();
      if (!Number.isFinite(price) || price <= 0) throw new Error("Live price was invalid.");
      this.lastPrice = price;
      return price;
    } catch (error) {
      if (this.lastPrice !== null) return this.lastPrice;
      throw error;
    }
  }

  private openPosition(managed: ManagedExecution, price: number) {
    const quantity = managed.allocatedAmount / price;
    const positionId = randomUUID();
    const now = new Date();
    managed.position = {
      id: positionId,
      executionId: managed.execution.executionId,
      tokenSymbol: "SOL",
      entryPrice: formatAmount(price),
      entryPriceNumber: price,
      amount: formatAmount(quantity),
      quantity,
      status: "OPEN",
      realizedPnl: null,
      openedAt: now,
      holdTicks: 0,
    };
    managed.trades.push({
      id: randomUUID(),
      side: "BUY",
      amount: formatAmount(quantity),
      price: formatAmount(price),
      executedAt: now,
    });
  }

  private closePosition(managed: ManagedExecution, price: number) {
    const position = managed.position;
    if (!position || position.status !== "OPEN") return;

    const pnl = position.quantity * (price - position.entryPriceNumber);
    managed.realizedPnl += pnl;
    position.realizedPnl = formatAmount(pnl);
    position.status = "CLOSED";
    managed.trades.push({
      id: randomUUID(),
      side: "SELL",
      amount: formatAmount(position.quantity),
      price: formatAmount(price),
      executedAt: new Date(),
    });
    managed.position = null;
  }

  private unrealizedPnl(managed: ManagedExecution): number {
    if (!managed.position || this.lastPrice === null) return 0;
    return managed.position.quantity * (this.lastPrice - managed.position.entryPriceNumber);
  }

  private userExecutions(userId: string) {
    return [...this.executions.values()].filter((managed) => managed.userId === userId);
  }

  private hasActiveExecutions() {
    return [...this.executions.values()].some((managed) => managed.execution.status === "ACTIVE");
  }

  private profileFor(strategyId: string) {
    let hash = 0;
    for (const char of strategyId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return STRATEGY_PROFILES[Math.abs(hash) % STRATEGY_PROFILES.length];
  }

  private publicPosition(position: ManagedPosition): Position {
    return {
      id: position.id,
      tokenSymbol: position.tokenSymbol,
      entryPrice: position.entryPrice,
      amount: position.amount,
      status: position.status,
      realizedPnl: position.realizedPnl,
    };
  }
}

function formatAmount(value: number): string {
  return value.toFixed(8);
}