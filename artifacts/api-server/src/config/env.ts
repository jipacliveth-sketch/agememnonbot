import "dotenv/config";
import { z } from "zod";

/**
 * Central, validated environment configuration.
 * Nothing in this codebase should read process.env directly outside this file.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  TELEGRAM_USE_WEBHOOK: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // --- Database ---
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // --- Redis ---
  REDIS_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  // --- App ---
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- Blockchain providers (add per network as they're implemented) ---
  SOLANA_RPC_URL: z.string().url().optional(),
  BSC_RPC_URL: z.string().url().optional(),
  BSC_USDT_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  DEPOSIT_WATCH_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
  WITHDRAWAL_MIN_AMOUNT: z.string().default("0.000001"),
  WITHDRAWAL_MAX_AMOUNT: z.string().default("1000000"),

  // --- Security ---
  ADMIN_SESSION_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast and loudly at startup rather than at first use.
    console.error("❌ Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  if (parsed.data.TELEGRAM_USE_WEBHOOK) {
    if (!parsed.data.TELEGRAM_WEBHOOK_URL || !parsed.data.TELEGRAM_WEBHOOK_SECRET) {
      console.error(
        "❌ TELEGRAM_USE_WEBHOOK=true requires TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET"
      );
      process.exit(1);
    }
  }

  const hasTcpRedis = Boolean(parsed.data.REDIS_URL);
  const hasUpstashRedis = Boolean(
    parsed.data.UPSTASH_REDIS_REST_URL && parsed.data.UPSTASH_REDIS_REST_TOKEN,
  );
  if (!hasTcpRedis && !hasUpstashRedis) {
    console.error(
      "❌ Redis configuration is required: set REDIS_URL or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN",
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
