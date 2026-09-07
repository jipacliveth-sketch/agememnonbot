import {
  TradingEngine,
  TradingStrategy,
  AccountTradingState,
  StartStrategyRequest,
  StrategyExecution,
  Position,
  Trade,
  PnL,
} from "./engine.interface";

/**
 * Default engine wired into the adapter until the real trading engine
 * is connected. Deliberately does NOT create trades, positions, or
 * P&L — per the UX rule against fabricated balances or activity
 * presented as real. Bot handlers should catch EngineNotConnectedError
 * and show "Trading Engine — Integration Pending" rather than crashing
 * or, worse, silently succeeding with fabricated data.
 */
export class EngineNotConnectedError extends Error {
  constructor(action: string) {
    super(`Trading engine is not connected yet — cannot ${action}.`);
    this.name = "EngineNotConnectedError";
  }
}

export class NotConnectedTradingEngine implements TradingEngine {
  async getAvailableStrategies(): Promise<TradingStrategy[]> {
    // Strategy metadata itself lives in Postgres (strategies table) and
    // is fine to show even with no engine connected — it's just not
    // startable yet. Callers should read strategies from the DB via
    // services/strategy.service.ts for display, and only hit the engine
    // when the user actually presses "Start Strategy".
    return [];
  }

  async getAccountState(userId: string): Promise<AccountTradingState> {
    return { userId, activePositionsCount: 0, todayPnl: "0" };
  }

  async startStrategy(request: StartStrategyRequest): Promise<StrategyExecution> {
    throw new EngineNotConnectedError("start a strategy");
  }

  async stopStrategy(executionId: string): Promise<void> {
    throw new EngineNotConnectedError("stop a strategy");
  }

  async getPositions(userId: string): Promise<Position[]> {
    return [];
  }

  async getTradeHistory(userId: string): Promise<Trade[]> {
    return [];
  }

  async getPnL(userId: string): Promise<PnL> {
    return { realized: "0", unrealized: "0" };
  }
}
