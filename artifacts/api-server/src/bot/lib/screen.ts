import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";

/**
 * Renders a "screen" by editing the existing bot message when possible
 * (so navigation feels like an app, not a stream of new messages),
 * falling back to sending a new message when there's nothing to edit
 * (e.g. responding to a text command rather than a callback query).
 */
export async function renderScreen(ctx: BotContext, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery) {
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
