import { InlineKeyboard } from "grammy";

/**
 * Centralized keyboard builders so navigation isn't reinvented in every
 * handler file. Callback data is intentionally short and only encodes
 * *what screen to show*, never sensitive values (amounts, addresses,
 * other users' ids) — those live in ctx.session.flow instead.
 */

export const mainMenuKeyboard = () =>
  new InlineKeyboard()
    .text("🚀 Trade", "menu:trade")
    .text("💰 Wallet", "menu:wallet")
    .row()
    .text("📊 Positions", "menu:positions")
    .text("📜 History", "menu:history")
    .row()
    .text("⚙️ Settings", "menu:settings");

export const backToMainMenu = () => new InlineKeyboard().text("🏠 Main Menu", "menu:main");

export function withBack(keyboard: InlineKeyboard, backCallback: string): InlineKeyboard {
  return keyboard.row().text("← Back", backCallback);
}

export function paginationRow(keyboard: InlineKeyboard, opts: { page: number; hasMore: boolean; baseCallback: string }) {
  const row = keyboard.row();
  if (opts.page > 0) row.text("← Prev", `${opts.baseCallback}:${opts.page - 1}`);
  if (opts.hasMore) row.text("Next →", `${opts.baseCallback}:${opts.page + 1}`);
  return keyboard;
}

export function confirmationKeyboard(confirmCallback: string, cancelCallback: string) {
  return new InlineKeyboard().text("✅ Confirm", confirmCallback).text("❌ Cancel", cancelCallback);
}
