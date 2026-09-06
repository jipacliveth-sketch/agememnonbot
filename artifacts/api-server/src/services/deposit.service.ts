import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { Database } from "../db/client";
import { blockchainTransactions, deposits, wallets } from "../db/schema";
import { getProvider } from "../blockchain/registry";
import { BlockchainTransaction, Network } from "../blockchain/provider.interface";
import { getPlatformDepositAsset, PLATFORM_DEPOSIT_ASSETS } from "../config/deposit-addresses";
import { assertPositive } from "../lib/decimal";
import { postLedgerEntryInTransaction } from "./ledger.service";
import { enqueueNotification } from "./notification.service";

function generateDepositReference(): string {
  return `DEP-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function initiatePlatformDeposit(
  db: Database,
  params: { userId: string; network: Network; asset: string }
) {
  const platformAsset = getPlatformDepositAsset(params.network, params.asset);
  if (!platformAsset) throw new Error(`No platform deposit address configured for ${params.network}/${params.asset}`);

  const existing = await db.query.deposits.findFirst({
    where: and(
      eq(deposits.userId, params.userId),
      eq(deposits.network, params.network),
      eq(deposits.asset, params.asset),
      inArray(deposits.status, ["PENDING", "DETECTED", "CONFIRMING"])
    ),
  });
  if (existing) return existing;

  const [deposit] = await db.insert(deposits).values({
    depositReference: generateDepositReference(),
    userId: params.userId,
    network: params.network,
    asset: params.asset,
    toAddress: platformAsset.address,
    requiredConfirmations: platformAsset.requiredConfirmations,
    status: "PENDING",
  }).returning();
  if (!deposit) throw new Error("Unable to create deposit record.");
  return deposit;
}

export async function submitDepositTxHash(db: Database, params: { depositId: string; txHash: string }) {
  const deposit = await db.query.deposits.findFirst({ where: eq(deposits.id, params.depositId) });
  if (!deposit) throw new Error("Deposit not found.");
  if (deposit.status === "CONFIRMED") return deposit;
  if (params.txHash.length < 32 || params.txHash.length > 128) throw new Error("Invalid transaction hash.");

  const conflicting = await db.query.deposits.findFirst({
    where: and(eq(deposits.network, deposit.network), eq(deposits.txHash, params.txHash)),
  });
  if (conflicting && conflicting.id !== deposit.id) throw new Error("This transaction hash has already been submitted for another deposit.");

  const provider = getProvider(deposit.network);
  const tx = await provider.getTransaction(params.txHash);
  if (!tx) throw new Error(`Transaction not found on ${deposit.network} yet.`);
  await recordObservedTransaction(db, tx);
  await recordDetectedTransaction(db, {
    depositId: deposit.id,
    txHash: params.txHash,
    fromAddress: tx.fromAddress ?? "unknown",
    amount: tx.amount,
    confirmations: tx.confirmations,
  });
  return verifyAndConfirmDeposit(db, deposit.id);
}

export async function recordDetectedTransaction(
  db: Database,
  params: { depositId: string; txHash: string; fromAddress: string; amount: string; confirmations: number }
) {
  const deposit = await db.query.deposits.findFirst({ where: eq(deposits.id, params.depositId) });
  if (!deposit) throw new Error("Deposit not found.");
  if (["CONFIRMED", "FAILED", "REJECTED", "REVERSED"].includes(deposit.status)) return deposit;
  const [updated] = await db.update(deposits).set({
    txHash: params.txHash,
    fromAddress: params.fromAddress,
    amount: params.amount,
    confirmations: Math.max(0, Math.floor(params.confirmations)),
    status: "CONFIRMING",
    detectedAt: deposit.detectedAt ?? new Date(),
    updatedAt: new Date(),
  }).where(eq(deposits.id, deposit.id)).returning();
  if (!updated) throw new Error("Unable to record detected deposit.");
  await enqueueNotification(db, {
    userId: deposit.userId,
    type: "DEPOSIT_DETECTED",
    payload: { network: deposit.network, asset: deposit.asset },
    dedupeKey: `deposit-detected:${deposit.id}`,
  });
  return updated;
}

export async function verifyAndConfirmDeposit(db: Database, depositId: string) {
  const deposit = await db.query.deposits.findFirst({ where: eq(deposits.id, depositId) });
  if (!deposit) throw new Error("Deposit not found.");
  if (deposit.status === "CONFIRMED") return deposit;
  if (!deposit.txHash) throw new Error("Deposit has no transaction hash.");

  const provider = getProvider(deposit.network);
  const tx = await provider.getTransaction(deposit.txHash);
  if (!tx) return markDepositRejected(db, deposit.id, "Transaction is no longer available.");

  const validDestination = sameAddress(deposit.network, tx.toAddress, deposit.toAddress);
  const validAsset = tx.asset === deposit.asset;
  const validAmount = (() => {
    try { return assertPositive(tx.amount, 12) > 0n; } catch { return false; }
  })();
  const validConfirmations = tx.confirmations >= deposit.requiredConfirmations;
  if (!validDestination) return markDepositRejected(db, deposit.id, "Destination address mismatch.");
  if (!validAsset) return markDepositRejected(db, deposit.id, "Asset mismatch: asset or token contract mismatch.");
  if (!validAmount) return markDepositRejected(db, deposit.id, "Invalid amount: on-chain amount must be positive.");
  if (!tx.successful) return markDepositRejected(db, deposit.id, "Transaction did not succeed on-chain.");

  await db.update(deposits).set({
    amount: tx.amount,
    confirmations: tx.confirmations,
    status: validConfirmations ? "CONFIRMING" : "DETECTED",
    updatedAt: new Date(),
  }).where(and(eq(deposits.id, deposit.id), eq(deposits.status, deposit.status)));
  if (!validConfirmations) return (await db.query.deposits.findFirst({ where: eq(deposits.id, deposit.id) }))!;

  return db.transaction(async (txDb) => {
    const wallet = await txDb.query.wallets.findFirst({ where: eq(wallets.userId, deposit.userId) });
    if (!wallet) throw new Error("No wallet found for deposit owner.");
    const [confirmed] = await txDb.update(deposits).set({
      status: "CONFIRMED",
      amount: tx.amount,
      confirmations: tx.confirmations,
      confirmedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(deposits.id, deposit.id), inArray(deposits.status, ["DETECTED", "CONFIRMING", "PENDING"]))).returning();
    if (!confirmed) return (await txDb.query.deposits.findFirst({ where: eq(deposits.id, deposit.id) }))!;

    await postLedgerEntryInTransaction(txDb, {
      userId: deposit.userId,
      walletId: wallet.id,
      type: "DEPOSIT",
      amount: tx.amount,
      currency: tx.asset,
      network: deposit.network,
      referenceType: "deposit",
      referenceId: deposit.id,
    });
    await enqueueNotification(txDb, {
      userId: deposit.userId,
      type: "DEPOSIT_CONFIRMED",
      payload: { amount: tx.amount, asset: tx.asset },
      dedupeKey: `deposit-confirmed:${deposit.id}`,
    });
    return confirmed;
  });
}

/**
 * Restart-safe polling job. Shared addresses cannot identify a user from a
 * chain transfer alone, so an unclaimed transfer is persisted for review.
 * Transfers to shared addresses are never attributed automatically. They are
 * persisted for reconciliation, while a user-supplied transaction hash is
 * required to link a transfer to a deposit record.
 */
export async function runDepositWatcher(db: Database) {
  for (const configured of PLATFORM_DEPOSIT_ASSETS) {
    if (!configured.address) continue;
    let provider;
    try { provider = getProvider(configured.network); } catch { continue; }
    try { await provider.watchAddress(configured.address); } catch { continue; }
    if (!provider.scanIncomingTransfers) continue;
    let transfers: BlockchainTransaction[] = [];
    try { transfers = await provider.scanIncomingTransfers(configured.address, configured.asset); } catch { continue; }
    for (const transfer of transfers) {
      await recordObservedTransaction(db, transfer);
      const claimed = await db.query.deposits.findFirst({
        where: and(eq(deposits.network, configured.network), eq(deposits.txHash, transfer.txHash)),
      });
      if (claimed) {
        try { await verifyAndConfirmDeposit(db, claimed.id); } catch { /* retry next cycle */ }
        continue;
      }
      // Shared custody address: do not guess the owner. A user must submit
      // the hash, or an operator must link it through a future admin tool.
    }
  }
  const pending = await db.query.deposits.findMany({
    where: inArray(deposits.status, ["DETECTED", "CONFIRMING"]),
    limit: 100,
  });
  for (const deposit of pending) {
    try { await verifyAndConfirmDeposit(db, deposit.id); } catch { /* retry next cycle */ }
  }
}

async function recordObservedTransaction(db: Database, tx: BlockchainTransaction) {
  await db.insert(blockchainTransactions).values({
    network: txNetwork(tx),
    txHash: tx.txHash,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    asset: tx.asset,
    amount: tx.amount,
    confirmations: tx.confirmations,
    rawPayload: null,
  }).onConflictDoNothing();
}

function txNetwork(tx: BlockchainTransaction): Network {
  return tx.asset === "USDT" ? "BSC" : "SOLANA";
}

async function markDepositRejected(db: Database, depositId: string, reason: string) {
  const [updated] = await db.update(deposits).set({
    status: "REJECTED",
    failureReason: reason,
    updatedAt: new Date(),
  }).where(and(eq(deposits.id, depositId), inArray(deposits.status, ["PENDING", "DETECTED", "CONFIRMING"]))).returning();
  if (!updated) {
    const current = await db.query.deposits.findFirst({ where: eq(deposits.id, depositId) });
    if (!current) throw new Error("Deposit not found.");
    return current;
  }
  throw new Error(reason);
}

function sameAddress(network: Network, actual: string | null, expected: string) {
  if (!actual) return false;
  return network === "BSC" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}