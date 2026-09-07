import { describe, expect, it, vi } from "vitest";
import { scanSolanaMarkets } from "../src/services/market-scanner.service";
import type { MarketData } from "../src/services/market-data.service";
import { discoverSolanaTokens } from "../src/services/token-discovery.service";

vi.mock("../src/services/token-discovery.service", () => ({ discoverSolanaTokens: vi.fn() }));

const mockedDiscovery = vi.mocked(discoverSolanaTokens);
function market(id: string, change: number, volume: number, cap: number): MarketData {
  return { id, name: id, symbol: id.slice(0, 3).toUpperCase(), network: "SOLANA", contractAddress: null, imageUrl: null, priceUsd: 1, priceChange24h: change, volume24hUsd: volume, marketCapUsd: cap, high24hUsd: 1, low24hUsd: 1, marketCapRank: null, lastUpdatedAt: new Date() };
}

describe("Solana market scanner", () => {
  it("ranks candidates using retrieved momentum and activity metrics", async () => {
    mockedDiscovery.mockResolvedValue([market("high", 20, 900_000, 1_000_000), market("low", 2, 10_000, 1_000_000)]);
    const results = await scanSolanaMarkets("trending", 2);
    expect(results[0].market.id).toBe("high");
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].reasons.join(" ")).toContain("momentum");
  });

  it("returns no qualifying setup when required market metrics are absent", async () => {
    mockedDiscovery.mockResolvedValue([market("missing", 10, null as unknown as number, 1000)]);
    expect(await scanSolanaMarkets("trending", 5)).toEqual([]);
  });
});
