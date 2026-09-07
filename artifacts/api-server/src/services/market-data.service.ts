import { withRetry } from "../lib/retry";

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";
const CACHE_TTL_MS = 30_000;
const COINGECKO_IDS: Record<string, string> = { SOL: "solana", USDT: "tether", BNB: "binancecoin", BTC: "bitcoin", ETH: "ethereum" };

export type MarketNetwork = "SOLANA" | "BSC" | "ETHEREUM" | "BASE" | "UNKNOWN";

export interface MarketData {
  id: string;
  name: string;
  symbol: string;
  network: MarketNetwork;
  contractAddress: string | null;
  imageUrl: string | null;
  priceUsd: number;
  priceChange24h: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  high24hUsd: number | null;
  low24hUsd: number | null;
  marketCapRank: number | null;
  lastUpdatedAt: Date;
}

export interface PriceQuote {
  symbol: string;
  usdPrice: number;
  usd24hChange: number | null;
  fetchedAt: Date;
}

export interface MarketDataProvider {
  discoverMarkets(options: { network: MarketNetwork; category?: string; limit?: number }): Promise<MarketData[]>;
  getMarket(id: string): Promise<MarketData>;
  getPrice(id: string): Promise<PriceQuote>;
}

interface CoinGeckoMarketRow {
  id?: string; name?: string; symbol?: string; current_price?: number;
  price_change_percentage_24h?: number | null; total_volume?: number | null;
  market_cap?: number | null; high_24h?: number | null; low_24h?: number | null;
  market_cap_rank?: number | null; image?: string | { small?: string } | null; last_updated?: string;
  platforms?: Record<string, string>;
  market_data?: {
    current_price?: Record<string, number>;
    price_change_percentage_24h?: number | null;
    total_volume?: Record<string, number | null>;
    market_cap?: Record<string, number | null>;
    high_24h?: Record<string, number | null>;
    low_24h?: Record<string, number | null>;
  };
}

class CoinGeckoMarketDataProvider implements MarketDataProvider {
  private readonly marketCache = new Map<string, { value: MarketData; expiresAt: number }>();
  private readonly discoveryCache = new Map<string, { value: MarketData[]; expiresAt: number }>();

  async discoverMarkets(options: { network: MarketNetwork; category?: string; limit?: number }): Promise<MarketData[]> {
    if (options.network !== "SOLANA") return [];
    const category = options.category ?? "solana-ecosystem";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cacheKey = `${category}:${limit}`;
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value.map(copyMarket);
    const params = new URLSearchParams({ vs_currency: "usd", category, order: "volume_desc", per_page: String(limit), page: "1", sparkline: "false" });
    const rows = await this.request<CoinGeckoMarketRow[]>(`/coins/markets?${params}`);
    const markets = rows.map((row) => normalizeMarket(row, "SOLANA")).filter(Boolean) as MarketData[];
    this.discoveryCache.set(cacheKey, { value: markets, expiresAt: Date.now() + CACHE_TTL_MS });
    for (const market of markets) this.marketCache.set(market.id, { value: market, expiresAt: Date.now() + CACHE_TTL_MS });
    return markets.map(copyMarket);
  }

  async getMarket(id: string): Promise<MarketData> {
    const cached = this.marketCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return copyMarket(cached.value);
    const row = await this.request<CoinGeckoMarketRow>(`/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`);
    const market = normalizeMarket(row, inferNetwork(row));
    if (!market) throw new Error(`CoinGecko returned incomplete market data for ${id}.`);
    this.marketCache.set(id, { value: market, expiresAt: Date.now() + CACHE_TTL_MS });
    return copyMarket(market);
  }

  async getPrice(id: string): Promise<PriceQuote> {
    const market = await this.getMarket(id);
    return { symbol: market.symbol, usdPrice: market.priceUsd, usd24hChange: market.priceChange24h, fetchedAt: market.lastUpdatedAt };
  }

  private async request<T>(path: string): Promise<T> {
    return withRetry(async () => {
      const response = await fetch(`${COINGECKO_BASE_URL}${path}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`CoinGecko request failed: HTTP ${response.status}`);
      return (await response.json()) as T;
    }, { operation: "coingecko_market_data", maxAttempts: 3, initialDelayMs: 300, maxDelayMs: 3_000 });
  }
}

export const marketDataProvider: MarketDataProvider = new CoinGeckoMarketDataProvider();
export async function discoverMarkets(options: { network: MarketNetwork; category?: string; limit?: number }) { return marketDataProvider.discoverMarkets(options); }
export async function getMarket(id: string) { return marketDataProvider.getMarket(id); }
export async function getUsdPrice(symbol: string): Promise<PriceQuote> {
  const id = COINGECKO_IDS[symbol.toUpperCase()];
  if (!id) throw new Error(`No CoinGecko id mapped for symbol "${symbol}".`);
  return marketDataProvider.getPrice(id);
}
export async function getUsdPrices(symbols: string[]): Promise<Map<string, PriceQuote>> {
  const entries = await Promise.all(symbols.map(async (symbol) => {
    try { return [symbol.toUpperCase(), await getUsdPrice(symbol)] as const; } catch { return null; }
  }));
  return new Map(entries.filter((entry): entry is readonly [string, PriceQuote] => entry !== null));
}

function normalizeMarket(row: CoinGeckoMarketRow, network: MarketNetwork): MarketData | null {
  const currentPrice = row.current_price ?? row.market_data?.current_price?.usd;
  const priceChange = row.price_change_percentage_24h ?? row.market_data?.price_change_percentage_24h;
  const volume = row.total_volume ?? row.market_data?.total_volume?.usd;
  const marketCap = row.market_cap ?? row.market_data?.market_cap?.usd;
  const high = row.high_24h ?? row.market_data?.high_24h?.usd;
  const low = row.low_24h ?? row.market_data?.low_24h?.usd;
  if (!row.id || !row.name || !row.symbol || typeof currentPrice !== "number" || currentPrice <= 0) return null;
  return {
    id: row.id, name: row.name, symbol: row.symbol.toUpperCase(), network,
    contractAddress: row.platforms?.solana ?? null, imageUrl: typeof row.image === "string" ? row.image : row.image?.small ?? null, priceUsd: currentPrice,
    priceChange24h: numberOrNull(priceChange), volume24hUsd: numberOrNull(volume),
    marketCapUsd: numberOrNull(marketCap), high24hUsd: numberOrNull(high), low24hUsd: numberOrNull(low),
    marketCapRank: numberOrNull(row.market_cap_rank), lastUpdatedAt: row.last_updated ? new Date(row.last_updated) : new Date(),
  };
}
function inferNetwork(row: CoinGeckoMarketRow): MarketNetwork {
  if (row.platforms?.solana) return "SOLANA";
  if (row.platforms?.["binance-smart-chain"]) return "BSC";
  if (row.platforms?.ethereum) return "ETHEREUM";
  return "UNKNOWN";
}
function numberOrNull(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function copyMarket(market: MarketData): MarketData { return { ...market, lastUpdatedAt: new Date(market.lastUpdatedAt) }; }
