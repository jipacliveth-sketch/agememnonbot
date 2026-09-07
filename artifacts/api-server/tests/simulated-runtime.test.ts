import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentTradingEngine } from "../src/trading-engine/development.engine";

describe("simulated market runtime", () => {
  const engines: DevelopmentTradingEngine[] = [];
  afterEach(() => { for (const engine of engines) engine.dispose(); vi.useRealTimers(); });

  it("applies configured fees and slippage to a real-price simulated exit", async () => {
    const prices = [100, 101];
    const engine = new DevelopmentTradingEngine({ autoStart: false, feeRate: 0.01, slippageBps: 100, priceSource: async () => prices.shift() ?? 101 });
    engines.push(engine);
    await engine.startStrategy({ userId: "fees-user", strategyId: "strategy-1", allocatedAmount: "100", takeProfit: 0.005 });
    await engine.runMarketTick();
    const pnl = await engine.getPnL("fees-user");
    const history = await engine.getTradeHistory("fees-user");
    expect(history).toHaveLength(3);
    expect(Number(pnl.realized)).toBeLessThan(1);
  });

  it("closes and stops a bot when its server-side runtime expires", async () => {
    vi.useFakeTimers();
    const engine = new DevelopmentTradingEngine({ autoStart: false, priceSource: async () => 100 });
    engines.push(engine);
    await engine.startStrategy({ userId: "runtime-user", strategyId: "strategy-1", allocatedAmount: "100", runtimeMinutes: 5 });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await engine.runMarketTick();
    expect(await engine.getPositions("runtime-user")).toHaveLength(0);
    expect((await engine.getTradeHistory("runtime-user")).map((trade) => trade.side)).toEqual(["BUY", "SELL"]);
  });
});
