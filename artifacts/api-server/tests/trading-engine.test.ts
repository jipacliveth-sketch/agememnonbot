import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentTradingEngine } from "../src/trading-engine/development.engine";

describe("development trading engine", () => {
  const engines: DevelopmentTradingEngine[] = [];

  afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
  });

  function makeEngine(prices: number[]) {
    let index = 0;
    const engine = new DevelopmentTradingEngine({
      autoStart: false,
      priceSource: async () => prices[Math.min(index++, prices.length - 1)],
    });
    engines.push(engine);
    return engine;
  }

  it("opens a live-price position and records an entry trade", async () => {
    const engine = makeEngine([100]);

    const execution = await engine.startStrategy({
      userId: "user-1",
      strategyId: "strategy-1",
      allocatedAmount: "50",
    });
    const positions = await engine.getPositions("user-1");
    const history = await engine.getTradeHistory("user-1");

    expect(execution.status).toBe("ACTIVE");
    expect(positions).toHaveLength(1);
    expect(positions[0].tokenSymbol).toBe("SOL");
    expect(Number(positions[0].entryPrice)).toBe(100);
    expect(history).toHaveLength(1);
    expect(history[0].side).toBe("BUY");
  });

  it("cycles an active strategy through an exit and a new entry", async () => {
    const engine = makeEngine([100, 101, 101]);

    await engine.startStrategy({
      userId: "user-2",
      strategyId: "strategy-2",
      allocatedAmount: "100",
    });
    await engine.runMarketTick();

    const history = await engine.getTradeHistory("user-2");
    const pnl = await engine.getPnL("user-2");

    expect(history.map((trade) => trade.side)).toEqual(["BUY", "SELL", "BUY"]);
    expect(Number(pnl.realized)).toBe(1);
    expect(Number(pnl.unrealized)).toBe(0);
  });

  it("stops an active execution without creating another position", async () => {
    const engine = makeEngine([100, 100]);

    const execution = await engine.startStrategy({
      userId: "user-3",
      strategyId: "strategy-3",
      allocatedAmount: "100",
    });
    await engine.stopStrategy(execution.executionId);

    expect(await engine.getPositions("user-3")).toHaveLength(0);
    expect((await engine.getTradeHistory("user-3")).map((trade) => trade.side)).toEqual(["BUY", "SELL"]);
  });

  it("keeps the last verified quote when the live price source temporarily fails", async () => {
    let shouldFail = false;
    const engine = new DevelopmentTradingEngine({
      autoStart: false,
      priceSource: async () => {
        if (shouldFail) throw new Error("market unavailable");
        return 100;
      },
    });
    engines.push(engine);

    await engine.startStrategy({
      userId: "user-4",
      strategyId: "strategy-4",
      allocatedAmount: "100",
    });
    shouldFail = true;

    const state = await engine.getAccountState("user-4");
    expect(state.activePositionsCount).toBe(1);
    expect(state.todayPnl).toBe("0.00000000");
  });
});