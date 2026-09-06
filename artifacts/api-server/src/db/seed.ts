import { db, pool } from "./client";
import { strategies } from "./schema";
import { eq } from "drizzle-orm";

/**
 * Seeds the example strategies from the spec. These are real database
 * rows. The strategy lifecycle is still owned by TradingEngineAdapter; the
 * database only controls which configured strategies are discoverable.
 */
const SEED_STRATEGIES = [
  {
    slug: "meme-sniper",
    name: "🚀 Meme Sniper",
    description: "Automated strategy focused on detecting and trading selected newly available tokens.",
    network: "SOLANA" as const,
    riskLevel: "HIGH" as const,
    status: "AVAILABLE" as const,
    enabled: true,
    minimumBalance: "50",
  },
  {
    slug: "solana-sniper",
    name: "⚡ Solana Sniper",
    description: "Targets high-momentum Solana token launches.",
    network: "SOLANA" as const,
    riskLevel: "HIGH" as const,
    status: "AVAILABLE" as const,
    enabled: true,
    minimumBalance: "50",
  },
  {
    slug: "new-token-hunter",
    name: "🎯 New Token Hunter",
    description: "Scans for newly deployed tokens matching configurable safety filters.",
    network: "SOLANA" as const,
    riskLevel: "MEDIUM" as const,
    status: "AVAILABLE" as const,
    enabled: true,
    minimumBalance: "25",
  },
  {
    slug: "trending-token-trader",
    name: "🔥 Trending Token Trader",
    description: "Follows tokens with rising volume and social attention.",
    network: "SOLANA" as const,
    riskLevel: "MEDIUM" as const,
    status: "AVAILABLE" as const,
    enabled: true,
    minimumBalance: "25",
  },
];

async function seed() {
  for (const s of SEED_STRATEGIES) {
    const existing = await db.query.strategies.findFirst({ where: eq(strategies.slug, s.slug) });
    if (existing) {
      await db.update(strategies).set({
        name: s.name,
        description: s.description,
        status: s.status,
        enabled: s.enabled,
        minimumBalance: s.minimumBalance,
        updatedAt: new Date(),
      }).where(eq(strategies.id, existing.id));
      console.log(`Updated strategy: ${s.slug}`);
    } else {
      await db.insert(strategies).values(s);
      console.log(`Inserted strategy: ${s.slug}`);
    }
  }
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error("Seed failed:", err);
    return pool.end().then(() => process.exit(1));
  });
