/**
 * Live market prices via CoinGecko's public API (no API key required for
 * this endpoint, subject to their public rate limits — ~10-30 req/min).
 * If this needs to scale beyond dev/small usage, move to a paid tier or
 * cache aggressively (see `CACHE_TTL_MS` below).
 *
 * Docs: https://www.coingecko.com/en/api/documentation
 */

import { withRetry } from "../lib/retry";

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

// CoinGecko's "id" for each asset we care about (not the same as the
// ticker symbol) — extend this map as more assets/strategies are added.
const COINGECKO_IDS: Record<string, string> = {
  SOL: "solana",
  USDT: "tether",
  BNB: "binancecoin",
  BTC: "bitcoin",
  ETH: "ethereum",
};

export interface PriceQuote {
  symbol: string;
  usdPrice: number;
  usd24hChange: number | null;
  fetchedAt: Date;
}

const CACHE_TTL_MS = 30_000; // 30s — plenty fresh for a dashboard, keeps well under rate limits
const cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

/**
 * Fetches the current USD price for one symbol (e.g. "SOL"). Throws if
 * the symbol isn't mapped or the request fails — callers should catch
 * and show a clear "price unavailable" state rather than a fabricated
 * number (same principle as the rest of this codebase: never fake data).
 */
export async function getUsdPrice(symbol: string): Promise<PriceQuote> {
  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.quote;
  }

  const coingeckoId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!coingeckoId) {
    throw new Error(`No CoinGecko id mapped for symbol "${symbol}" — add it to COINGECKO_IDS.`);
  }

  const url = `${COINGECKO_BASE_URL}/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true`;
  const body = await withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinGecko price fetch failed for ${symbol}: HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
  }, {
    operation: `coingecko_price.${symbol.toUpperCase()}`,
    maxAttempts: 3,
    initialDelayMs: 300,
    maxDelayMs: 3_000,
  });
  const entry = body[coingeckoId];
  if (!entry || typeof entry.usd !== "number") {
    throw new Error(`CoinGecko returned no price data for ${symbol}`);
  }

  const quote: PriceQuote = {
    symbol: symbol.toUpperCase(),
    usdPrice: entry.usd,
    usd24hChange: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
    fetchedAt: new Date(),
  };

  cache.set(symbol, { quote, expiresAt: Date.now() + CACHE_TTL_MS });
  return quote;
}

/**
 * Fetches multiple symbols in a single CoinGecko request (cheaper on
 * rate limits than calling getUsdPrice in a loop). Returns a map keyed
 * by uppercased symbol; a symbol that fails to resolve is simply
 * omitted from the result rather than throwing for the whole batch —
 * callers should handle a missing key as "price unavailable" for that
 * one asset.
 */
export async function getUsdPrices(symbols: string[]): Promise<Map<string, PriceQuote>> {
  const result = new Map<string, PriceQuote>();
  const toFetch: { symbol: string; id: string }[] = [];

  for (const symbol of symbols) {
    const upper = symbol.toUpperCase();
    const cached = cache.get(upper);
    if (cached && cached.expiresAt > Date.now()) {
      result.set(upper, cached.quote);
      continue;
    }
    const id = COINGECKO_IDS[upper];
    if (id) toFetch.push({ symbol: upper, id });
  }

  if (toFetch.length === 0) return result;

  const ids = toFetch.map((t) => t.id).join(",");
  const url = `${COINGECKO_BASE_URL}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  const body = await withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinGecko batch price fetch failed: HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
  }, {
    operation: "coingecko_price_batch",
    maxAttempts: 3,
    initialDelayMs: 300,
    maxDelayMs: 3_000,
  });

  for (const { symbol, id } of toFetch) {
    const entry = body[id];
    if (!entry || typeof entry.usd !== "number") continue;

    const quote: PriceQuote = {
      symbol,
      usdPrice: entry.usd,
      usd24hChange: typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : null,
      fetchedAt: new Date(),
    };
    cache.set(symbol, { quote, expiresAt: Date.now() + CACHE_TTL_MS });
    result.set(symbol, quote);
  }

  return result;
}
