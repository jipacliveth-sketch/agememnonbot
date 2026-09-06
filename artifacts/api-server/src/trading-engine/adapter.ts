import { TradingEngine } from "./engine.interface";
import { DevelopmentTradingEngine } from "./development.engine";

/**
 * Singleton-style adapter. The rest of the application (Telegram handlers,
 * services) imports `tradingEngineAdapter` from this file only — never a
 * concrete engine implementation directly. Swapping in the real engine
 * later means changing ONE line: the assignment below.
 */
class TradingEngineAdapter implements TradingEngine {
  private engine: TradingEngine = new DevelopmentTradingEngine();

  /** Called once at startup once a real engine implementation exists. */
  setEngine(engine: TradingEngine) {
    this.engine = engine;
  }

  getAvailableStrategies() {
    return this.engine.getAvailableStrategies();
  }
  getAccountState(userId: string) {
    return this.engine.getAccountState(userId);
  }
  startStrategy(request: Parameters<TradingEngine["startStrategy"]>[0]) {
    return this.engine.startStrategy(request);
  }
  stopStrategy(executionId: string) {
    return this.engine.stopStrategy(executionId);
  }
  getPositions(userId: string) {
    return this.engine.getPositions(userId);
  }
  getTradeHistory(userId: string) {
    return this.engine.getTradeHistory(userId);
  }
  getPnL(userId: string) {
    return this.engine.getPnL(userId);
  }

  dispose() {
    const disposable = this.engine as TradingEngine & { dispose?: () => void };
    disposable.dispose?.();
  }
}

export const tradingEngineAdapter = new TradingEngineAdapter();
