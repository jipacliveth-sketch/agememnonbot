export interface MemeTokenConfig {
  symbol: string;
  marketId: string;
}

export const TRADE_MEME_TOKENS: readonly MemeTokenConfig[] = [
  { symbol: "DOGE", marketId: "dogecoin" },
  { symbol: "SHIB", marketId: "shiba-inu" },
  { symbol: "PEPE", marketId: "pepe" },
  { symbol: "BONK", marketId: "bonk" },
  { symbol: "WIF", marketId: "dogwifhat" },
  { symbol: "FLOKI", marketId: "floki" },
  { symbol: "BRETT", marketId: "brett" },
  { symbol: "BOME", marketId: "book-of-meme" },
  { symbol: "MEME", marketId: "memecoin-2" },
  { symbol: "MOG", marketId: "mog-coin" },
];

export const SNIPER_MEME_TOKENS: readonly MemeTokenConfig[] = [
  { symbol: "PEPE", marketId: "pepe" },
  { symbol: "BONK", marketId: "bonk" },
  { symbol: "WIF", marketId: "dogwifhat" },
  { symbol: "FLOKI", marketId: "floki" },
  { symbol: "SHIB", marketId: "shiba-inu" },
  { symbol: "DOGE", marketId: "dogecoin" },
  { symbol: "BOME", marketId: "book-of-meme" },
  { symbol: "BRETT", marketId: "brett" },
  { symbol: "MOG", marketId: "mog-coin" },
  { symbol: "MEME", marketId: "memecoin-2" },
];

export const SIMULATION_CONFIG = {
  tradeRuntimeMs: 5 * 60_000,
  sniperRuntimeMs: 60_000,
  updateIntervalMs: 30_000,
  sniperMinPositionPercent: 0.1,
  sniperMaxPositionPercent: 0.2,
  maxPositivePnlPercent: 0.3,
  maxSniperUses: 3,
  sniperWindowMs: 24 * 60 * 60_000,
} as const;

export function chooseMemeToken(universe: readonly MemeTokenConfig[], random = Math.random) {
  if (!universe.length) throw new Error("The meme-token universe is empty.");
  return universe[Math.floor(random() * universe.length)]!;
}