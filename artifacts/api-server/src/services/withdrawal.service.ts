import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { Database } from "../db/client";
import { walletBalances, wallets, withdrawals } from "../db/schema";
import { Network } from "../blockchain/provider.interface";
import { getPlatformDepositAsset } from "../config/deposit-addresses";
import { assertPositive, parseFixed } from "../lib/decimal";
import { env } from "../config/env";
import { postLedgerEntryInTransaction } from "./ledger.service";
import { enqueueNotification } from "./notification.service";

const WITHDRAWAL_STATUSES = [
  "REQUESTED", "PENDING_REVIEW", "APPROVED", "FUNDS_RESERVED", "SIGNING",
  "BROADCAST", "CONFIRMING", "COMPLETED", "FAILED", "CANCELLED",
] as const;
export type WithdrawalStatus = typeof WITHDRAWAL_STATUSES[number];

function reference() {
  return `WDR-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function requestWithdrawal(
  db: Database,
  params: { userId: string; network: Network; asset: string; destinationAddress: string; amount: string }
) {
  const configured = getPlatformDepositAsset(params.network, params.asset);
  if (!configured) throw new Error("This asset/network is not enabled for withdrawals.");
  validateDestination(params.network, params.destinationAddress);
  const amount = assertPositive(params.amount, 12);
  if (amount < parseFixed(env.WITHDRAWAL_MIN_AMOUNT, 12)) throw new Error("Withdrawal amount is below the minimum.");
  if (amount > parseFixed(env.WITHDRAWAL_MAX_AMOUNT, 12)) throw new Error("Withdrawal amount exceeds the maximum.");

  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, params.userId) });
  if (!wallet) throw new Error("Wallet not found.");
  const balance = await db.query.walletBalances.findFirst({
    where: and(
      eq(walletBalances.walletId, wallet.id),
      eq(walletBalances.userId, params.userId),
      eq(walletBalances.network, params.network),
      eq(walletBalances.asset, params.asset),
    ),
  });
  if (!balance || parseFixed(balance.availableBalance, 12) < amount) {
    throw new Error("Insufficient available balance.");
  }

  const [created] = await db.insert(withdrawals).values({
    withdrawalReference: reference(),
    userId: params.userId,
    network: params.network,
    asset: params.asset,
    destinationAddress: params.destinationAddress,
    amount: params.amount,
    status: "PENDING_REVIEW",
  }).returning();
  if (!created) throw new Error("Unable to create withdrawal request.");
  await enqueueNotification(db, {
    userId: params.userId,
    type: "WITHDRAWAL_STATUS",
    payload: { amount: params.amount, asset: params.asset, status: "PENDING_REVIEW" },
    dedupeKey: `withdrawal-status:${created.id}:PENDING_REVIEW`,
  });
  return created;
}

export async function approveWithdrawal(db: Database, withdrawalId: string, adminUserId?: string) {
  return db.transaction(async (tx) => {
    const withdrawal = await tx.query.withdrawals.findFirst({ where: eq(withdrawals.id, withdrawalId) });
    if (!withdrawal) throw new Error("Withdrawal not found.");
    if (withdrawal.status === "FUNDS_RESERVED" || withdrawal.status === "SIGNING") return withdrawal;
    if (withdrawal.status !== "PENDING_REVIEW" && withdrawal.status !== "APPROVED") {
      throw new Error(`Cannot approve withdrawal in ${withdrawal.status} state.`);
    }
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.userId, withdrawal.userId) });
    if (!wallet) throw new Error("Wallet not found.");
    const [approved] = await tx.update(withdrawals).set({
      status: "APPROVED",
      reviewedByAdminId: adminUserId,
      updatedAt: new Date(),
    }).where(and(eq(withdrawals.id, withdrawalId), eq(withdrawals.status, withdrawal.status))).returning();
    if (!approved) return (await tx.query.withdrawals.findFirst({ where: eq(withdrawals.id, withdrawalId) }))!;
    const entry = await postLedgerEntryInTransaction(tx, {
      userId: withdrawal.userId,
      walletId: wallet.id,
      type: "WITHDRAWAL_RESERVATION",
      amount: withdrawal.amount,
      currency: withdrawal.asset,
      network: withdrawal.network,
      referenceType: "withdrawal",
      referenceId: withdrawal.id,
    });
    const [reserved] = await tx.update(withdrawals).set({
      status: "FUNDS_RESERVED",
      reservationLedgerEntryId: entry.id,
      updatedAt: new Date(),
    }).where(eq(withdrawals.id, withdrawal.id)).returning();
    return reserved;
  });
}

/**
 * Signing is deliberately an injected boundary. This repository never
 * receives or handles private keys. Until a custody signer is provided,
 * the request fails safely and releases its reservation rather than
 * pretending that a transaction was broadcast.
 */
export async function processWithdrawal(
  db: Database,
  withdrawalId: string,
  signer?: { broadcast: (request: { network: Network; asset: string; destinationAddress: string; amount: string }) => Promise<{ txHash: string }> }
) {
  if (!signer) {
    await failWithdrawal(db, withdrawalId, "UNTESTED — EXTERNAL INFRASTRUCTURE REQUIRED");
    throw new Error("UNTESTED — EXTERNAL INFRASTRUCTURE REQUIRED");
  }
  const withdrawal = await transitionWithdrawal(db, withdrawalId, "SIGNING", ["FUNDS_RESERVED"]);
  try {
    const broadcast = await signer.broadcast({
      network: withdrawal.network,
      asset: withdrawal.asset,
      destinationAddress: withdrawal.destinationAddress,
      amount: withdrawal.amount,
    });
    if (!broadcast.txHash) throw new Error("Signer returned no transaction hash.");
    const [row] = await db.update(withdrawals).set({
      status: "BROADCAST",
      txHash: broadcast.txHash,
      updatedAt: new Date(),
    }).where(and(eq(withdrawals.id, withdrawal.id), eq(withdrawals.status, "SIGNING"))).returning();
    await enqueueNotification(db, {
      userId: withdrawal.userId,
      type: "WITHDRAWAL_STATUS",
      payload: { amount: withdrawal.amount, asset: withdrawal.asset, status: "BROADCAST" },
      dedupeKey: `withdrawal-status:${withdrawal.id}:BROADCAST`,
    });
    return row;
  } catch (error) {
    await failWithdrawal(db, withdrawalId, error instanceof Error ? error.message : "Signing failed.");
    throw error;
  }
}

export async function cancelWithdrawal(db: Database, withdrawalId: string) {
  const withdrawal = await db.query.withdrawals.findFirst({ where: eq(withdrawals.id, withdrawalId) });
  if (!withdrawal) throw new Error("Withdrawal not found.");
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(withdrawal.status)) return withdrawal;
  if (["BROADCAST", "CONFIRMING"].includes(withdrawal.status)) {
    throw new Error("A broadcast withdrawal cannot be cancelled.");
  }
  if (withdrawal.status === "FUNDS_RESERVED" || withdrawal.status === "SIGNING") {
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, withdrawal.userId) });
    if (wallet) await postLedgerEntry(db, {
      userId: withdrawal.userId,
      walletId: wallet.id,
      type: "WITHDRAWAL_RELEASE",
      amount: withdrawal.amount,
      currency: withdrawal.asset,
      network: withdrawal.network,
      referenceType: "withdrawal",
      referenceId: withdrawal.id,
    });
  }
  const [cancelled] = await db.update(withdrawals).set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(withdrawals.id, withdrawalId), inArray(withdrawals.status, ["PENDING_REVIEW", "APPROVED", "FUNDS_RESERVED", "SIGNING"]))).returning();
  return cancelled ?? (await db.query.withdrawals.findFirst({ where: eq(withdrawals.id, withdrawalId) }))!;
}

async function failWithdrawal(db: Database, withdrawalId: string, reason: string) {
  const withdrawal = await db.query.withdrawals.findFirst({ where: eq(withdrawals.id, withdrawalId) });
  if (!withdrawal) return;
  if (["FUNDS_RESERVED", "SIGNING"].includes(withdrawal.status)) {
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, withdrawal.userId) });
    if (wallet) await postLedgerEntry(db, {
      userId: withdrawal.userId,
      walletId: wallet.id,
      type: "WITHDRAWAL_RELEASE",
      amount: withdrawal.amount,
      currency: withdrawal.asset,
      network: withdrawal.network,
      referenceType: "withdrawal",
      referenceId: withdrawal.id,
    });
  }
  await db.update(withdrawals).set({
    status: "FAILED",
    failureReason: reason,
    updatedAt: new Date(),
  }).where(and(eq(withdrawals.id, withdrawalId), inArray(withdrawals.status, ["FUNDS_RESERVED", "SIGNING", "BROADCAST", "CONFIRMING"])));
  await enqueueNotification(db, {
    userId: withdrawal.userId,
    type: "WITHDRAWAL_STATUS",
    payload: { amount: withdrawal.amount, asset: withdrawal.asset, status: "FAILED" },
    dedupeKey: `withdrawal-status:${withdrawal.id}:FAILED`,
  });
}

async function transitionWithdrawal(db: Database, id: string, status: WithdrawalStatus, from: WithdrawalStatus[]) {
  const [updated] = await db.update(withdrawals).set({ status, updatedAt: new Date() })
    .where(and(eq(withdrawals.id, id), inArray(withdrawals.status, from))).returning();
  if (!updated) throw new Error("Withdrawal is no longer in an actionable state.");
  return updated;
}

function validateDestination(network: Network, address: string) {
  const valid = network === "BSC"
    ? /^0x[a-fA-F0-9]{40}$/.test(address)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (!valid) throw new Error("Destination address is invalid for the selected network.");
}

// Local import kept at the bottom to make the reservation flow explicit.
import { postLedgerEntry } from "./ledger.service";