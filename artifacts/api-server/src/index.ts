import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Bot, GrammyError, HttpError, webhookCallback } from "grammy";
import { env } from "./config/env";
import { createBot } from "./bot";
import type { BotContext } from "./bot/context";
import { db, pool } from "./db/client";
import { registerProvider } from "./blockchain/registry";
import { SolanaProvider } from "./blockchain/providers/solana.provider";
import { BscProvider } from "./blockchain/providers/bsc.provider";
import { startPlatformJobs } from "./jobs/platform.jobs";
import { dispatchPendingNotifications } from "./services/notification.service";
import { RedisStorage } from "./bot/redis-storage";
import { log, logError } from "./lib/logger";
import { withRetry } from "./lib/retry";
import { markProcessStarted, markProcessStopped } from "./lib/process-state";
import { RuntimeLease } from "./lib/runtime-lease";
import { tradingEngineAdapter } from "./trading-engine/adapter";

let stopPlatformJobs: () => Promise<void> = async () => {};
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
let notificationTask: Promise<void> | undefined;
let notificationWorkerStopped = true;
let bot: Bot<BotContext> | undefined;
let healthServer: ReturnType<typeof Fastify> | undefined;
let telegramStartPromise: Promise<void> | undefined;
let pollingTask: Promise<void> | undefined;
let runtimeLease: RuntimeLease | undefined;
let shutdownPromise: Promise<void> | undefined;
let shutdownRequested = false;
let lifecycle: "starting" | "ready" | "shutting_down" | "stopped" = "starting";
const readiness = {
  database: false,
  redis: false,
  http: false,
  jobs: false,
  telegram: false,
};

process.on("uncaughtException", (error) => {
  logError("unexpected_error", error, { kind: "uncaught_exception" });
  void initiateShutdown("uncaught_exception", 1);
});

process.on("unhandledRejection", (reason) => {
  logError("unexpected_error", reason, { kind: "unhandled_rejection" });
  void initiateShutdown("unhandled_rejection", 1);
});

process.on("SIGTERM", () => {
  void initiateShutdown("sigterm", 0);
});

process.on("SIGINT", () => {
  void initiateShutdown("sigint", 0);
});

/**
 * Registers a network's provider only once its RPC URL is configured.
 * Missing provider configuration is fail-closed: the watcher records no
 * credit and the user-facing verification path reports an unavailable
 * provider instead of fabricating a confirmation.
 */
function registerConfiguredProviders() {
  if (env.SOLANA_RPC_URL) registerProvider(new SolanaProvider(env.SOLANA_RPC_URL));
  if (env.BSC_RPC_URL) registerProvider(new BscProvider(env.BSC_RPC_URL));
}

async function main() {
  log("info", "application_started", {
    pid: process.pid,
    nodeVersion: process.version,
    environment: env.NODE_ENV,
    transport: env.TELEGRAM_USE_WEBHOOK ? "webhook" : "polling",
  });
  if (markProcessStarted()) {
    log("warn", "application_restarted_by_host", { pid: process.pid });
  }

  await withRetry(verifyDatabaseReady, {
    operation: "database_startup_check",
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 5_000,
  });
  readiness.database = true;
  log("info", "database_connection_established");

  await withRetry(verifyRedisReady, {
    operation: "redis_startup_check",
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 5_000,
  });
  readiness.redis = true;
  log("info", "redis_connection_established");
  runtimeLease = new RuntimeLease(
    createRedisStorage(),
    () => void initiateShutdown("runtime_lease_lost", 1),
  );
  await withRetry(() => runtimeLease!.acquire(), {
    operation: "runtime_lease_acquisition",
    maxAttempts: 8,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    shouldRetry: (error) =>
      error instanceof Error &&
      error.message.includes("already owns the runtime lease"),
  });

  registerConfiguredProviders();
  bot = createBot();
  await startHealthServer(bot);

  stopPlatformJobs = startPlatformJobs(db, {
    depositIntervalMs: env.DEPOSIT_WATCH_INTERVAL_MS,
    reconciliationIntervalMs: env.RECONCILIATION_INTERVAL_MS,
  });
  readiness.jobs = true;
  startNotificationWorker();
  await startTelegram();
  lifecycle = "ready";
  log("info", "application_ready", { readiness: getReadiness() });
}

async function verifyRedisReady() {
  await createRedisStorage().ping();
}

function createRedisStorage() {
  const redisRestUrl =
    env.UPSTASH_REDIS_REST_URL ??
    (env.REDIS_URL?.startsWith("http") ? env.REDIS_URL : undefined);
  const redisTcpUrl = env.REDIS_URL?.startsWith("http") ? undefined : env.REDIS_URL;

  return new RedisStorage(
    redisTcpUrl,
    undefined,
    redisRestUrl && env.UPSTASH_REDIS_REST_TOKEN
      ? { url: redisRestUrl, token: env.UPSTASH_REDIS_REST_TOKEN }
      : undefined,
  );
}

async function startHealthServer(currentBot: Bot<BotContext>) {
  if (healthServer) return;

  healthServer = Fastify({ logger: env.LOG_LEVEL === "debug" });
  healthServer.get("/api/healthz", async () => ({
    status: "ok",
    lifecycle,
    uptimeSeconds: Math.round(process.uptime()),
  }));
  healthServer.get("/health", async () => ({
    status: "ok",
    lifecycle,
  }));
  healthServer.get("/api/readyz", async (_request: FastifyRequest, reply: FastifyReply) => {
    const ready = Object.values(readiness).every(Boolean) && lifecycle === "ready";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      lifecycle,
      readiness: getReadiness(),
    });
  });

  if (env.TELEGRAM_USE_WEBHOOK) {
    healthServer.post(
      "/telegram/webhook",
      webhookCallback(currentBot, "fastify", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    );
  }

  await healthServer.listen({ port: env.PORT, host: "0.0.0.0" });
  readiness.http = true;
  log("info", "http_server_started", { port: env.PORT });
}

async function startTelegram() {
  if (!bot) throw new Error("Telegram bot has not been created.");
  if (telegramStartPromise) return telegramStartPromise;

  telegramStartPromise = env.TELEGRAM_USE_WEBHOOK
    ? startWebhook(bot)
    : startPolling(bot);
  return telegramStartPromise;
}

async function startWebhook(currentBot: Bot<BotContext>) {
  await withRetry(
    () =>
      currentBot.api.setWebhook(env.TELEGRAM_WEBHOOK_URL!, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    {
      operation: "telegram_set_webhook",
      maxAttempts: 5,
      initialDelayMs: 500,
      maxDelayMs: 5_000,
      shouldRetry: isRecoverableTelegramError,
    },
  );
  readiness.telegram = true;
  log("info", "telegram_connection_established", { transport: "webhook" });
}

async function startPolling(currentBot: Bot<BotContext>) {
  await withRetry(
    async () => {
      if (shutdownRequested) return;
      if (currentBot.isRunning()) return;

      // Clearing a webhook before polling is idempotent and prevents a
      // previous deployment mode from competing with long polling.
      await currentBot.api.deleteWebhook();

      let started = false;
      let resolveStarted!: () => void;
      let rejectStarted!: (error: unknown) => void;
      const startedSignal = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });

      pollingTask = currentBot.start({
        onStart: (botInfo) => {
          started = true;
          readiness.telegram = true;
          log("info", "telegram_connection_established", {
            transport: "polling",
            username: botInfo.username,
          });
          resolveStarted();
        },
      });

      void pollingTask.then(
        () => {
          if (shutdownRequested) {
            if (!started) resolveStarted();
            return;
          }
          const error = new Error("Telegram polling stopped unexpectedly.");
          if (!started) rejectStarted(error);
          else {
            logError("telegram_polling_stopped", error);
            void initiateShutdown("telegram_polling_stopped", 1);
          }
        },
        (error) => {
          if (!started) rejectStarted(error);
          else {
            logError("telegram_polling_failed", error);
            void initiateShutdown("telegram_polling_failed", 1);
          }
        },
      );

      await startedSignal;
    },
    {
      operation: "telegram_polling_start",
      maxAttempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 15_000,
      shouldRetry: isRecoverableTelegramError,
    },
  );
}

function startNotificationWorker() {
  if (!notificationWorkerStopped) return;
  notificationWorkerStopped = false;

  const schedule = () => {
    if (notificationWorkerStopped || shutdownRequested) return;
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined;
      notificationTask = withRetry(
        () =>
          dispatchPendingNotifications(db, async (telegramUserId, text) => {
            if (!bot) throw new Error("Telegram bot is unavailable.");
            await bot.api.sendMessage(telegramUserId.toString(), text);
          }),
        {
          operation: "notification_dispatch_cycle",
          maxAttempts: 3,
          initialDelayMs: 500,
          maxDelayMs: 5_000,
        },
      )
        .catch((error) => logError("notification_dispatch_cycle_failed", error))
        .finally(() => {
          notificationTask = undefined;
          schedule();
        });
      void notificationTask;
    }, 5_000);
    notificationTimer.unref();
  };

  schedule();
  log("info", "notification_worker_started");
}

async function stopNotificationWorker() {
  notificationWorkerStopped = true;
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = undefined;
  await settle(notificationTask, "notification_worker", 5_000);
  notificationTask = undefined;
  log("info", "notification_worker_stopped");
}

/**
 * Fail before Telegram polling starts when the application database is
 * unreachable or has not been migrated. Without this check the process can
 * appear healthy while every update fails in identity middleware.
 */
async function verifyDatabaseReady() {
  const result = await pool.query<{ table_name: string | null }>(`
    SELECT table_name
    FROM unnest(ARRAY[
      'users',
      'wallets',
      'wallet_balances',
      'ledger_entries',
      'strategies',
      'strategy_executions',
      'user_settings',
      'notifications',
      'deposits',
      'withdrawals'
    ]) AS required(table_name)
    WHERE to_regclass('public.' || required.table_name) IS NULL
  `);

  if (result.rows.length > 0) {
    throw new Error(
      `Database schema is incomplete. Run "npm run db:migrate"; missing tables: ${result.rows
        .map((row) => row.table_name)
        .join(", ")}`
    );
  }
}

async function initiateShutdown(reason: string, exitCode: number) {
  if (shutdownPromise) return shutdownPromise;

  shutdownRequested = true;
  lifecycle = "shutting_down";
  log("warn", "shutdown_initiated", { reason, exitCode });
  shutdownPromise = performShutdown(exitCode);
  return shutdownPromise;
}

async function performShutdown(exitCode: number) {
  await stopNotificationWorker();
  await stopPlatformJobs();
  tradingEngineAdapter.dispose();
  await runtimeLease?.stop();

  if (bot) {
    if (env.TELEGRAM_USE_WEBHOOK) {
      await settle(
        withRetry(() => bot!.api.deleteWebhook(), {
          operation: "telegram_delete_webhook",
          maxAttempts: 2,
          initialDelayMs: 250,
          maxDelayMs: 1_000,
          shouldRetry: isRecoverableTelegramError,
        }),
        "telegram_webhook_shutdown",
        3_000,
      );
    } else if (bot.isRunning()) {
      await settle(bot.stop(), "telegram_polling_shutdown", 7_000);
    }
    await settle(pollingTask, "telegram_polling_task_shutdown", 7_000);
  }

  await settle(healthServer?.close(), "http_server_shutdown", 5_000);
  await settle(pool.end(), "database_pool_shutdown", 5_000);
  markProcessStopped();
  lifecycle = "stopped";
  log("info", "process_exiting", { exitCode });
  process.exitCode = exitCode;
  process.exit(exitCode);
}

async function settle(
  task: Promise<unknown> | undefined,
  operation: string,
  timeoutMs: number,
) {
  if (!task) return;
  try {
    await Promise.race([
      task,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${operation} timed out.`)), timeoutMs),
      ),
    ]);
  } catch (error) {
    logError("shutdown_resource_failed", error, { operation });
  }
}

function getReadiness() {
  return { ...readiness };
}

function isRecoverableTelegramError(error: unknown) {
  if (error instanceof HttpError) return true;
  if (!(error instanceof GrammyError)) return true;
  return error.error_code === 409 || error.error_code === 429 || error.error_code >= 500;
}

main().catch((error) => {
  logError("startup_failed", error);
  void initiateShutdown("startup_failed", 1);
});
