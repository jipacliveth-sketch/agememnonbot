export interface TradingStrategy {
  id: string;
  slug: string;
  name: string;
  description: string;
  network: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  minimumBalance: string;
}

export interface AccountTradingState {
  userId: string;
  activePositionsCount: number;
  todayPnl: string;
}

export interface StartStrategyRequest {
  userId: string;
  strategyId: string;
  allocatedAmount: string;
}

export interface StrategyExecution {
  executionId: string;
  engineExecutionRef: string;
  status: "STARTING" | "ACTIVE" | "STOPPING" | "STOPPED" | "FAILED";
}

export interface Position {
  id: string;
  tokenSymbol: string;
  entryPrice: string;
  amount: string;
  status: "OPEN" | "CLOSED";
  realizedPnl: string | null;
}

export interface Trade {
  id: string;
  side: "BUY" | "SELL";
  amount: string;
  price: string;
  executedAt: Date;
}

export interface PnL {
  realized: string;
  unrealized: string;
}

/**
 * Contract the real trading engine must satisfy. The Telegram bot and
 * application backend talk ONLY to TradingEngineAdapter (see adapter.ts),
 * which in turn talks to a concrete implementation of this interface.
 *
 * DO NOT implement real trading logic against this interface directly
 * in bot handlers. When the actual engine is ready, write a class that
 * implements TradingEngine and wire it into the adapter — nothing else
 * in the codebase should need to change.
 */
export interface TradingEngine {
  getAvailableStrategies(): Promise<TradingStrategy[]>;
  getAccountState(userId: string): Promise<AccountTradingState>;
  startStrategy(request: StartStrategyRequest): Promise<StrategyExecution>;
  stopStrategy(executionId: string): Promise<void>;
  getPositions(userId: string): Promise<Position[]>;
  getTradeHistory(userId: string): Promise<Trade[]>;
  getPnL(userId: string): Promise<PnL>;
}
