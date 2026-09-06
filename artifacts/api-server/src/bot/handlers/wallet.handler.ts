import { InlineKeyboard } from "grammy";
import type { NextFunction } from "grammy";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { ledgerEntries, walletBalances, wallets, withdrawals } from "../../db/schema";
import { BotContext } from "../context";
import { paginationRow, withBack } from "../keyboards/navigation";
import { renderScreen } from "../lib/screen";
import { initiatePlatformDeposit, submitDepositTxHash } from "../../services/deposit.service";
import { PLATFORM_DEPOSIT_ASSETS, getPlatformDepositAsset } from "../../config/deposit-addresses";
import { getUsdPrices } from "../../services/market-data.service";
import { Network } from "../../blockchain/provider.interface";
import { formatFixed } from "../../lib/decimal";
import { requestWithdrawal } from "../../services/withdrawal.service";
import { tradingEngineAdapter } from "../../trading-engine/adapter";
import { sendChainCheckAnimation, sendTokenVisual } from "../media";

export async function walletHandler(ctx: BotContext) {
  const userId = ctx.session.userId!;
  const [wallet, balances] = await Promise.all([
    db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }),
    db.query.walletBalances.findMany({ where: eq(walletBalances.userId, userId) }),
  ]);
  const assets = balances.length
    ? balances.map((b) => `${b.asset} (${b.network})\nAvailable: ${b.availableBalance}\nLocked: ${b.lockedBalance}`).join("\n\n")
    : "No asset balances yet.";
  const text = [
    "💰 WALLET", "",
    "Asset balances", assets, "",
    `Legacy account balance: $${wallet?.availableBalance ?? "0"}`,
    `Legacy locked balance: $${wallet?.lockedBalance ?? "0"}`,
  ].join("\n");
  const keyboard = withBack(
    new InlineKeyboard()
      .text("Deposit", "wallet:deposit")
      .text("Withdraw", "wallet:withdraw")
      .row()
      .text("Transaction History", "wallet:history")
      .row()
      .text("Withdrawal History", "wallet:withdrawals"),
    "menu:main"
  );
  await renderScreen(ctx, text, keyboard);
}

export async function depositAssetSelectHandler(ctx: BotContext) {
  const prices = await getUsdPrices(PLATFORM_DEPOSIT_ASSETS.map((a) => a.asset)).catch(() => new Map());
  const keyboard = new InlineKeyboard();
  const lines = ["💰 DEPOSIT", "", "Select asset:", ""];
  for (const asset of PLATFORM_DEPOSIT_ASSETS) {
    const price = prices.get(asset.asset);
    lines.push(price ? `${asset.displayName} — $${price.usdPrice.toFixed(price.usdPrice < 1 ? 4 : 2)}` : asset.displayName);
    keyboard.text(asset.displayName, `deposit:asset:${asset.network}:${asset.asset}`).row();
  }
  await renderScreen(ctx, lines.join("\n"), withBack(keyboard, "menu:wallet"));
}

export async function depositAddressHandler(ctx: BotContext, network: Network, asset: string) {
  const configured = getPlatformDepositAsset(network, asset);
  if (!configured) {
    await renderScreen(ctx, "This asset is not currently configured for deposits.", withBack(new InlineKeyboard(), "menu:wallet"));
    return;
  }
  const deposit = await initiatePlatformDeposit(db, { userId: ctx.session.userId!, network, asset });
  ctx.session.flow = { name: "deposit", step: "awaiting_tx_hash", data: { depositId: deposit.id } };
  if (asset === "SOL" || asset === "USDT") await sendTokenVisual(ctx, asset);
  await renderScreen(ctx, [
    `💰 DEPOSIT — ${configured.displayName}`, "",
    "Send only this asset on the selected network:",
    "",
    configured.address,
    "",
    "The watcher checks configured addresses automatically. If attribution is ambiguous, paste the transaction hash here.",
  ].join("\n"), withBack(new InlineKeyboard().text("Cancel", "flow:cancel"), "menu:wallet"));
}

export async function withdrawalAssetSelectHandler(ctx: BotContext) {
  const keyboard = new InlineKeyboard();
  for (const asset of PLATFORM_DEPOSIT_ASSETS) {
    keyboard.text(asset.displayName, `withdraw:asset:${asset.network}:${asset.asset}`).row();
  }
  await renderScreen(ctx, "💸 WITHDRAW\n\nSelect the asset and network.", withBack(keyboard, "menu:wallet"));
}

export async function withdrawalDestinationHandler(ctx: BotContext, network: Network, asset: string) {
  if (!getPlatformDepositAsset(network, asset)) throw new Error("Unsupported withdrawal asset.");
  ctx.session.flow = { name: "withdrawal", step: "awaiting_destination", data: { network, asset } };
  await renderScreen(ctx, `💸 WITHDRAW ${asset}\n\nReply with the destination address.\n\nNever send a seed phrase or private key.`, withBack(new InlineKeyboard().text("Cancel", "flow:cancel"), "menu:wallet"));
}

export async function withdrawalTextHandler(ctx: BotContext, next: NextFunction) {
  const text = ctx.message?.text?.trim();
  if (!text || ctx.session.flow?.name !== "withdrawal") {
    await next();
    return;
  }
  const flow = ctx.session.flow;
  if (flow.step === "awaiting_destination") {
    ctx.session.flow = { ...flow, step: "awaiting_amount", data: { ...flow.data, destinationAddress: text } };
    await ctx.reply("Reply with the amount to withdraw.");
    return;
  }
  if (flow.step === "awaiting_amount") {
    const amount = text;
    const withdrawal = await requestWithdrawal(db, {
      userId: ctx.session.userId!,
      network: flow.data.network as Network,
      asset: flow.data.asset,
      destinationAddress: flow.data.destinationAddress,
      amount,
    });
    ctx.session.flow = undefined;
    await renderScreen(ctx, [
      "✅ WITHDRAWAL REQUESTED", "",
      `Reference: ${withdrawal.withdrawalReference}`,
      `Amount: ${withdrawal.amount} ${withdrawal.asset}`,
      `Network: ${withdrawal.network}`,
      "Status: PENDING_REVIEW",
      "",
      "No transaction has been broadcast. You will be notified when status changes.",
    ].join("\n"), withBack(new InlineKeyboard(), "menu:wallet"));
  }
}

export async function depositTxHashSubmissionHandler(ctx: BotContext, next: NextFunction) {
  const text = ctx.message?.text?.trim();
  if (!text || ctx.message?.text?.startsWith("/") || ctx.session.flow?.name !== "deposit") {
    await next();
    return;
  }
  const depositId = ctx.session.flow.data.depositId;
  const checking = await sendChainCheckAnimation(ctx);
  try {
    const deposit = await submitDepositTxHash(db, { depositId, txHash: text });
    ctx.session.flow = undefined;
    await renderScreen(ctx, [
      deposit.status === "CONFIRMED" ? "✅ DEPOSIT CONFIRMED" : "🔎 DEPOSIT CONFIRMING",
      "",
      `Amount: ${deposit.amount ?? "—"} ${deposit.asset}`,
      `Confirmations: ${deposit.confirmations}/${deposit.requiredConfirmations}`,
      deposit.status === "CONFIRMED" ? "Your asset balance has been updated." : "The watcher will re-check it automatically.",
    ].join("\n"), withBack(new InlineKeyboard(), "menu:wallet"));
  } finally {
    if (ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, checking.message_id).catch(() => undefined);
  }
}

export async function cancelFlowHandler(ctx: BotContext) {
  ctx.session.flow = undefined;
  await walletHandler(ctx);
}

const LEDGER_TYPE_LABEL: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRADE_RESERVATION: "Trading Allocation",
  TRADE_RELEASE: "Trading Allocation Released",
  WITHDRAWAL_RESERVATION: "Withdrawal Reserved",
  WITHDRAWAL_RELEASE: "Withdrawal Released",
  TRADING_PROFIT: "Trading Profit",
  TRADING_LOSS: "Trading Loss",
  FEE: "Fee",
  ADJUSTMENT: "Adjustment",
};

export async function transactionHistoryHandler(ctx: BotContext, page = 0) {
  const userId = ctx.session.userId!;
  const rows = await db.query.ledgerEntries.findMany({
    where: eq(ledgerEntries.userId, userId),
    orderBy: [desc(ledgerEntries.createdAt), desc(ledgerEntries.id)],
    limit: 11,
    offset: Math.max(0, page) * 10,
  });
  const entries = rows.slice(0, 10);
  const keyboard = new InlineKeyboard();
  paginationRow(keyboard, { page, hasMore: rows.length > 10, baseCallback: "history:page" });
  if (!entries.length) {
    await renderScreen(ctx, "📜 TRANSACTION HISTORY\n\nNo transactions on this page.", withBack(keyboard, "menu:wallet"));
    return;
  }
  const lines = entries.map((entry) => `${entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}\n${LEDGER_TYPE_LABEL[entry.type] ?? entry.type} · ${entry.currency}\n${formatFixed(entry.amount, 8, 8)} · ${entry.status}`);
  const trades = page === 0 ? await tradingEngineAdapter.getTradeHistory(userId) : [];
  if (trades.length) lines.push("ENGINE TRADES\n" + trades.slice(0, 10).map((trade) => `${trade.executedAt.toISOString().slice(0, 16).replace("T", " ")} ${trade.side} ${trade.amount} @ ${trade.price}`).join("\n"));
  await renderScreen(ctx, ["📜 TRANSACTION HISTORY", "", lines.join("\n\n")].join("\n"), withBack(keyboard, "menu:wallet"));
}

export async function withdrawalHistoryHandler(ctx: BotContext, page = 0) {
  const rows = await db.query.withdrawals.findMany({
    where: eq(withdrawals.userId, ctx.session.userId!),
    orderBy: [desc(withdrawals.createdAt), desc(withdrawals.id)],
    limit: 11,
    offset: Math.max(0, page) * 10,
  });
  const keyboard = new InlineKeyboard();
  paginationRow(keyboard, { page, hasMore: rows.length > 10, baseCallback: "withdrawals:page" });
  const text = rows.length
    ? ["💸 WITHDRAWAL HISTORY", "", ...rows.slice(0, 10).map((row) => `${row.withdrawalReference}\n${row.amount} ${row.asset} · ${row.status}\n${row.destinationAddress}`)].join("\n\n")
    : "💸 WITHDRAWAL HISTORY\n\nNo withdrawals on this page.";
  await renderScreen(ctx, text, withBack(keyboard, "menu:wallet"));
}