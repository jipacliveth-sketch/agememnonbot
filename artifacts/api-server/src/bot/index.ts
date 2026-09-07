import { Bot, GrammyError, HttpError, session } from "grammy";
import { BotContext, SessionData } from "./context";
import { identityMiddleware } from "./middleware/identity.middleware";
import { env } from "../config/env";
import { startHandler } from "./handlers/start.handler";
import { mainMenuHandler } from "./handlers/menu.handler";
import {
  walletHandler,
  depositAssetSelectHandler,
  depositAddressHandler,
  depositTxHashSubmissionHandler,
  transactionHistoryHandler,
  withdrawalAssetSelectHandler,
  withdrawalDestinationHandler,
  withdrawalTextHandler,
  withdrawalHistoryHandler,
  cancelFlowHandler,
} from "./handlers/wallet.handler";
import {
  tradeMenuHandler,
  strategyDetailHandler,
  strategyDetailsHandler,
  strategyStartHandler,
  strategyStopHandler,
  activeStrategiesHandler,
  tradeNetworkHandler,
  tradeTokenHandler,
  sniperEntryHandler,
  tradeCancelHandler,
} from "./handlers/strategy.handler";
import { positionsHandler } from "./handlers/positions.handler";
import { learnMoreHandler, settingsHandler, supportedNetworksHandler, toggleNotificationsHandler } from "./handlers/settings.handler";
import { renderError } from "./lib/screen";
import { Network } from "../blockchain/provider.interface";
import { RedisStorage } from "./redis-storage";
import { RateLimiter } from "./rate-limit";
import { withRetry } from "../lib/retry";
import { NextFunction } from "grammy";

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(async (prev, method, payload, signal) =>
    withRetry(() => prev(method, payload, signal), {
      operation: `telegram_api.${method}`,
      maxAttempts: 4,
      initialDelayMs: 250,
      maxDelayMs: 4_000,
      shouldRetry: isTransientTelegramError,
    }),
  );

  bot.use(
    session<SessionData, BotContext>({
      initial: () => ({}),
      storage: new RedisStorage<SessionData>(
        env.REDIS_URL?.startsWith("http") ? undefined : env.REDIS_URL,
        undefined,
        (env.UPSTASH_REDIS_REST_URL ??
          (env.REDIS_URL?.startsWith("http") ? env.REDIS_URL : undefined)) &&
        env.UPSTASH_REDIS_REST_TOKEN
          ? {
              url:
                env.UPSTASH_REDIS_REST_URL ??
                env.REDIS_URL!,
              token: env.UPSTASH_REDIS_REST_TOKEN,
            }
          : undefined,
      ),
    })
  );

  bot.use(identityMiddleware);
  const limiter = new RateLimiter(30, 60_000);
  bot.use(async (ctx, next) => {
    const key = `${ctx.from?.id ?? "anonymous"}:${ctx.callbackQuery ? "callback" : "message"}`;
    if (!limiter.allow(key)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Too many requests. Try again shortly." });
      else await ctx.reply("Too many requests. Please try again shortly.");
      return;
    }
    await next();
  });

  // Catches any error thrown by a downstream handler and shows the clean,
  // non-leaky error screen (with correlation id) instead of the user
  // seeing nothing while bot.catch() below only logs server-side.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      await renderError(ctx, err);
    }
  });

  // Registered before specific callback routes so it wraps them (calls
  // next() to run the matched handler, then acknowledges the callback
  // query) rather than being skipped by an earlier handler's implicit stop.
  bot.on("callback_query:data", async (ctx, next) => {
    await next();
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* already answered by a specific handler */
    }
  });

  // Intercepts plain text messages ONLY while the user is mid-deposit-flow
  // (pasting a tx hash); calls next() otherwise so commands still work.
  bot.on("message:text", tradeTextHandler);
  bot.on("message:text", withdrawalTextHandler);
  bot.on("message:text", depositTxHashSubmissionHandler);

  // --- Commands ---
  // Commands and callbacks route into the SAME handlers — no duplicated
  // business logic between the two entry points.
  bot.command("start", startHandler);
  bot.command("menu", mainMenuHandler);
  bot.command("wallet", walletHandler);
  bot.command("balance", walletHandler);
  bot.command("trade", tradeMenuHandler);
  bot.command("positions", positionsHandler);
  bot.command("history", (ctx) => transactionHistoryHandler(ctx, 0));
  bot.command("settings", settingsHandler);
  bot.command("help", (ctx) =>
    ctx.reply(["Commands:", "/start /menu /wallet /balance", "/trade /positions /history /settings"].join("\n"))
  );

  // --- Callback query routing ---
  bot.callbackQuery("menu:main", mainMenuHandler);
  bot.callbackQuery("menu:wallet", walletHandler);
  bot.callbackQuery("menu:trade", tradeMenuHandler);
  bot.callbackQuery("menu:positions", positionsHandler);
  bot.callbackQuery("menu:history", (ctx) => transactionHistoryHandler(ctx, 0));
  bot.callbackQuery("menu:settings", settingsHandler);
  bot.callbackQuery("menu:learn_more", learnMoreHandler);

  bot.callbackQuery("wallet:deposit", depositAssetSelectHandler);
  bot.callbackQuery(/^deposit:asset:([A-Z]+):([A-Z0-9]+)$/, (ctx) =>
    depositAddressHandler(ctx, ctx.match![1] as Network, ctx.match![2])
  );
  bot.callbackQuery("wallet:withdraw", withdrawalAssetSelectHandler);
  bot.callbackQuery("wallet:history", (ctx) => transactionHistoryHandler(ctx, 0));
  bot.callbackQuery("wallet:withdrawals", (ctx) => withdrawalHistoryHandler(ctx, 0));
  bot.callbackQuery("flow:cancel", cancelFlowHandler);
  bot.callbackQuery(/^withdraw:asset:([A-Z]+):([A-Z0-9]+)$/, (ctx) =>
    withdrawalDestinationHandler(ctx, ctx.match![1] as Network, ctx.match![2])
  );

  bot.callbackQuery(/^strategy:view:(.+)$/, (ctx) => strategyDetailHandler(ctx, ctx.match![1]));
  bot.callbackQuery(/^strategy:details:(.+)$/, (ctx) => strategyDetailsHandler(ctx, ctx.match![1]));
  bot.callbackQuery(/^strategy:start:([^:]+):([^:]+):(5|10|15)$/, (ctx) => strategyStartHandler(ctx, ctx.match![1], ctx.match![2], Number(ctx.match![3]) as 5 | 10 | 15));
  bot.callbackQuery(/^strategy:start:(.+)$/, (ctx) => strategyStartHandler(ctx, ctx.match![1]));
  bot.callbackQuery(/^strategy:stop:(.+)$/, (ctx) => strategyStopHandler(ctx, ctx.match![1]));
  bot.callbackQuery(/^trade:network:(SOLANA|BSC)$/, (ctx) => tradeNetworkHandler(ctx, ctx.match![1] as "SOLANA" | "BSC"));
  bot.callbackQuery(/^trade:token:(.+)$/, (ctx) => tradeTokenHandler(ctx, ctx.match![1]));
  bot.callbackQuery("trade:sniper", sniperEntryHandler);
  bot.callbackQuery("trade:cancel", tradeCancelHandler);
  bot.callbackQuery("strategy:active", activeStrategiesHandler);
  bot.callbackQuery(/^history:page:(\d+)$/, (ctx) => transactionHistoryHandler(ctx, Number(ctx.match![1])));
  bot.callbackQuery(/^withdrawals:page:(\d+)$/, (ctx) => withdrawalHistoryHandler(ctx, Number(ctx.match![1])));
  bot.callbackQuery("settings:notifications", toggleNotificationsHandler);
  bot.callbackQuery("settings:networks", supportedNetworksHandler);

  bot.catch((err) => {
    console.error("Unhandled bot error:", err.error);
  });

  return bot;
}

async function tradeTextHandler(ctx: BotContext, next: NextFunction) {
  const text = ctx.message?.text?.trim().toLowerCase();
  if (!text || text.startsWith("/")) {
    await next();
    return;
  }
  const inTrade = ctx.session.flow?.name === "trade";
  if (text === "trade" || (inTrade && (text === "back" || text === "cancel" || text === "solana" || text === "show tokens" || text === "sniper" || text === "find something hot" || text === "retry" || text === "stop"))) {
    if (text === "trade") return tradeMenuHandler(ctx);
    if (text === "cancel") return tradeCancelHandler(ctx);
    if (text === "stop") {
      const executionId = ctx.session.flow?.data.executionId;
      return executionId ? strategyStopHandler(ctx, executionId) : activeStrategiesHandler(ctx);
    }
    if (text === "back") {
      const step = ctx.session.flow?.step;
      if (step === "VIEWING_TOKEN") {
        return tradeNetworkHandler(ctx, (ctx.session.flow?.data.network as "SOLANA" | "BSC") ?? "SOLANA");
      }
      if (step === "ERROR" && ctx.session.flow?.data.strategySlug && ctx.session.flow.data.marketId) return tradeTokenHandler(ctx, ctx.session.flow.data.marketId);
      return tradeMenuHandler(ctx);
    }
    if (text === "sniper" || text === "find something hot") return sniperEntryHandler(ctx);
    if (text === "retry" && ctx.session.flow?.step === "ERROR") {
      const failedStrategy = ctx.session.flow.data.strategySlug;
      if (failedStrategy) return strategyStartHandler(ctx, failedStrategy);
      return sniperEntryHandler(ctx);
    }
    return tradeNetworkHandler(ctx, "SOLANA");
  }
  await next();
}

function isTransientTelegramError(error: unknown) {
  if (error instanceof HttpError) return true;
  return error instanceof GrammyError &&
    (error.error_code === 429 || error.error_code >= 500);
}
