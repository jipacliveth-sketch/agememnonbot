import { afterEach, describe, expect, it, vi } from "vitest";
import { marketDataProvider } from "../src/services/market-data.service";

afterEach(() => vi.unstubAllGlobals());

describe("CoinGecko market data provider", () => {
  it("normalizes Solana discovery markets without inventing missing metrics", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "real-solana-token", name: "Real Token", symbol: "real", current_price: 0.1234,
        price_change_percentage_24h: 12.5, total_volume: 1200000, market_cap: null,
        image: "https://example.test/token.png", platforms: { solana: "So111111" }, last_updated: "2026-09-07T00:00:00Z",
      }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const markets = await marketDataProvider.discoverMarkets({ network: "SOLANA", category: "test-category", limit: 1 });
    expect(markets[0]).toMatchObject({ id: "real-solana-token", symbol: "REAL", network: "SOLANA", contractAddress: "So111111", priceUsd: 0.1234, marketCapUsd: null });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("category=test-category"), expect.anything());
  });

  it("normalizes nested CoinGecko token detail market data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "detail-token", name: "Detail Token", symbol: "dtk", image: { small: "https://example.test/small.png" }, platforms: { solana: "TokenAddress" }, market_data: {
        current_price: { usd: 2.5 }, price_change_percentage_24h: -3.2, total_volume: { usd: 9000 }, market_cap: { usd: 50000 }, high_24h: { usd: 2.8 }, low_24h: { usd: 2.2 },
      } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const market = await marketDataProvider.getMarket("detail-token");
    expect(market).toMatchObject({ id: "detail-token", priceUsd: 2.5, priceChange24h: -3.2, volume24hUsd: 9000, marketCapUsd: 50000, contractAddress: "TokenAddress" });
  });
});
