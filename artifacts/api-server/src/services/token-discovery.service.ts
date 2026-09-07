import { discoverMarkets, MarketData } from "./market-data.service";

export type DiscoveryFilter = "all" | "meme" | "trending" | "high-volume" | "high-momentum" | "recently-active";

export async function discoverSolanaTokens(filter: DiscoveryFilter = "all", limit = 12): Promise<MarketData[]> {
  const category = filter === "meme" ? "solana-meme-coins" : "solana-ecosystem";
  const markets = await discoverMarkets({ network: "SOLANA", category, limit: Math.max(limit * 3, 30) });
  const eligible = markets.filter((market) => {
    if (market.id === "solana") return false;
    if (filter === "meme") return true;
    if (filter === "high-volume") return (market.volume24hUsd ?? 0) > 0;
    if (filter === "high-momentum") return (market.priceChange24h ?? 0) > 0;
    if (filter === "trending") return (market.priceChange24h ?? 0) > 0 && (market.volume24hUsd ?? 0) > 0;
    if (filter === "recently-active") return (market.volume24hUsd ?? 0) > 0;
    return true;
  });
  return eligible.slice(0, limit);
}
