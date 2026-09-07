import { describe, expect, it } from "vitest";
import { chooseMemeToken, SIMULATION_CONFIG, SNIPER_MEME_TOKENS, TRADE_MEME_TOKENS } from "../src/config/simulation";
import { calculatePositionSize, calculateTradeResult, capPositivePnl } from "../src/services/simulation.service";

describe("trade and sniper simulation rules", () => {
  it("selects only configured meme tokens", () => {
    const allowed = new Set(TRADE_MEME_TOKENS.map((token) => token.symbol));
    for (let index = 0; index < 20; index += 1) expect(allowed.has(chooseMemeToken(TRADE_MEME_TOKENS, () => index / 20).symbol)).toBe(true);
    expect([...allowed]).not.toContain("BTC");
    expect([...allowed]).not.toContain("ETH");
  });

  it("keeps sniper sizing between ten and twenty percent", () => {
    expect(calculatePositionSize(1_000, undefined, undefined, () => 0).amount).toBe(100);
    expect(calculatePositionSize(1_000, undefined, undefined, () => 1).amount).toBe(200);
    expect(SNIPER_MEME_TOKENS).toHaveLength(10);
  });

  it("calculates fees, losses, and the positive session cap", () => {
    const result = calculateTradeResult({ entryPrice: 100, exitPrice: 90, positionSize: 200, takeProfit: 105, stopLoss: 95, outcome: "STOP_LOSS", feeRate: 0.01 });
    expect(result.grossPnl).toBe(-20);
    expect(result.feeAmount).toBe(2);
    expect(result.netPnl).toBe(-22);
    expect(capPositivePnl(500, 1_000)).toBe(1_000 * SIMULATION_CONFIG.maxPositivePnlPercent);
  });
});
