import { discoverSolanaTokens, DiscoveryFilter } from "./token-discovery.service";
import { MarketData } from "./market-data.service";

export interface SniperCandidate {
  market: MarketData;
  score: number;
  reasons: string[];
  components: { momentum: number; volume: number; liquidity: number; trend: number };
}

export async function scanSolanaMarkets(filter: DiscoveryFilter = "trending", limit = 5): Promise<SniperCandidate[]> {
  const markets = await discoverSolanaTokens(filter, Math.max(limit * 3, 12));
  return markets.map(rankMarket)
    .filter((candidate) => candidate.market.priceChange24h !== null && candidate.market.volume24hUsd !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function rankMarket(market: MarketData): SniperCandidate {
  const momentum = clamp(normalize(market.priceChange24h ?? 0, -20, 40));
  const volume = market.volume24hUsd && market.marketCapUsd ? clamp((market.volume24hUsd / market.marketCapUsd) * 100) : 0;
  const liquidity = market.volume24hUsd ? clamp(normalize(Math.log10(market.volume24hUsd), 3, 9)) : 0;
  const trend = market.priceChange24h !== null && market.priceChange24h > 0 ? 100 : 0;
  const score = Math.round(momentum * 0.35 + volume * 0.3 + liquidity * 0.2 + trend * 0.15);
  const reasons = [
    `24h momentum ${formatPercent(market.priceChange24h)}`,
    `volume/market cap ${market.volume24hUsd && market.marketCapUsd ? `${((market.volume24hUsd / market.marketCapUsd) * 100).toFixed(2)}%` : "unavailable"}`,
    `24h volume ${formatUsd(market.volume24hUsd)}`,
  ];
  return { market, score, reasons, components: { momentum, volume, liquidity, trend } };
}
function normalize(value: number, min: number, max: number) { return ((value - min) / (max - min)) * 100; }
function clamp(value: number) { return Math.max(0, Math.min(100, value)); }
function formatPercent(value: number | null) { return value === null ? "unavailable" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`; }
function formatUsd(value: number | null) { return value === null ? "unavailable" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`; }
