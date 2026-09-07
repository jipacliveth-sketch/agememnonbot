import { InlineKeyboard } from "grammy";
import { InputFile } from "grammy";
import { resolve } from "node:path";
import { BotContext } from "../context";

/**
 * Renders a "screen" by editing the existing bot message when possible
 * (so navigation feels like an app, not a stream of new messages),
 * falling back to sending a new message when there's nothing to edit
 * (e.g. responding to a text command rather than a callback query).
 */
export async function renderScreen(ctx: BotContext, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery) {
    if (ctx.session.flow?.name === "trade" && ctx.chat && ctx.callbackQuery.message && "photo" in ctx.callbackQuery.message) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => undefined);
      await ctx.reply(text, { reply_markup: keyboard });
      return;
    }
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    } catch {
      // Fall through to sending a new message if edit fails (e.g. message
      // too old, or content identical to current message).
    }
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

export async function renderMediaScreen(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard | undefined,
  assetName = "agamemnon-helmet.png",
) {
  const media = assetName.startsWith("http") ? assetName : new InputFile(resolve(process.cwd(), "assets/telegram", assetName));
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageMedia({ type: "photo", media, caption: text }, { reply_markup: keyboard });
      return;
    } catch {
      if (ctx.chat && ctx.callbackQuery.message) {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => undefined);
      }
    }
  }
  await ctx.replyWithPhoto(media, { caption: text, reply_markup: keyboard });
}

/**
 * Standard error screen. Never surfaces stack traces or internals to the
 * user — logs the real error server-side with a correlation id instead.
 */
export async function renderError(ctx: BotContext, error: unknown) {
  const correlationId = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.error(`[ERR-${correlationId}]`, error);

  const text = ["⚠️ Something went wrong.", "", "We couldn't complete that action.", "Please try again.", "", `Reference: ERR-${correlationId}`].join(
    "\n"
  );

  await renderScreen(ctx, text, undefined);
}
