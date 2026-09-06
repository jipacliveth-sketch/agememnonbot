import { eq, and, sql, desc } from "drizzle-orm";
import { Database } from "../db/client";
import { wallets, walletBalances, ledgerEntries } from "../db/schema";
import { Network } from "../blockchain/provider.interface";
import { parseFixed, signedDecimal, unsignedDecimal } from "../lib/decimal";

type LedgerEntryType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "TRADE_RESERVATION"
  | "TRADE_RELEASE"
  | "WITHDRAWAL_RESERVATION"
  | "WITHDRAWAL_RELEASE"
  | "TRADING_PROFIT"
  | "TRADING_LOSS"
  | "FEE"
  | "ADJUSTMENT";

// Sign convention: callers pass an unsigned magnitude + type; the service
// decides the sign, so a bug in a handler can't accidentally credit a
// withdrawal or debit a deposit.
const CREDIT_TYPES: LedgerEntryType[] = [
  "DEPOSIT", "TRADE_RELEASE", "WITHDRAWAL_RELEASE", "TRADING_PROFIT",
];
const DEBIT_TYPES: LedgerEntryType[] = [
  "WITHDRAWAL", "TRADE_RESERVATION", "WITHDRAWAL_RESERVATION", "TRADING_LOSS", "FEE",
];
// ADJUSTMENT can go either way — the admin explicitly supplies the signed amount.

export interface PostLedgerEntryInput {
  userId: string;
  walletId: string;
  type: LedgerEntryType;
  amount: string; // unsigned decimal magnitude, except for ADJUSTMENT (signed)
  network?: Network;
  currency?: string;
  referenceType: string;
  referenceId: string;
  note?: string;
}

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function getSignedAmount(input: PostLedgerEntryInput): string {
  if (input.type === "ADJUSTMENT") {
    if (!input.note) {
      throw new Error("ADJUSTMENT ledger entries require a note (reason for the adjustment)");
    }
    return input.amount; // caller supplies the sign explicitly
  }

  if (CREDIT_TYPES.includes(input.type)) {
    return unsignedDecimal(parseFixed(input.amount), 12);
  }

  if (DEBIT_TYPES.includes(input.type)) {
    return `-${unsignedDecimal(parseFixed(input.amount), 12)}`;
  }

  throw new Error(`Unknown ledger entry type: ${input.type}`);
}

/**
 * Posts a ledger entry using an existing transaction and atomically updates
 * the cached wallet balance in that same transaction.
 */
export async function postLedgerEntryInTransaction(
  tx: DatabaseTransaction,
  input: PostLedgerEntryInput
) {
  const signedAmount = getSignedAmount(input);
  const network = input.network ?? "BSC";
  const asset = input.currency ?? "USD";

  // Idempotency check up front for a clear early return; the unique
  // index is the real backstop if there's a race.
  const existing = await tx.query.ledgerEntries.findFirst({
    where: and(
      eq(ledgerEntries.referenceType, input.referenceType),
      eq(ledgerEntries.referenceId, input.referenceId),
      eq(ledgerEntries.type, input.type)
    ),
  });
  if (existing) return existing;

  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      userId: input.userId,
      walletId: input.walletId,
      type: input.type,
      status: "POSTED",
      amount: signedAmount,
      currency: asset,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note,
    })
    .returning();
  const entry = inserted[0];
  if (!entry) {
    const concurrent = await tx.query.ledgerEntries.findFirst({
      where: and(
        eq(ledgerEntries.referenceType, input.referenceType),
        eq(ledgerEntries.referenceId, input.referenceId),
        eq(ledgerEntries.type, input.type)
      ),
    });
    if (!concurrent) throw new Error("Ledger entry was not created.");
    return concurrent;
  }

  await tx
    .insert(walletBalances)
    .values({
      walletId: input.walletId,
      userId: input.userId,
      network,
      asset,
      availableBalance: "0",
      lockedBalance: "0",
    })
    .onConflictDoNothing({
      target: [walletBalances.walletId, walletBalances.network, walletBalances.asset],
    });

  // Locked-balance-affecting types adjust lockedBalance instead of
  // availableBalance; everything else moves availableBalance.
  const isLockAffecting =
    input.type === "TRADE_RESERVATION" ||
    input.type === "TRADE_RELEASE" ||
    input.type === "WITHDRAWAL_RESERVATION" ||
    input.type === "WITHDRAWAL_RELEASE";

  if (isLockAffecting) {
    // TRADE_RESERVATION moves funds FROM available TO locked.
    // TRADE_RELEASE moves them back FROM locked TO available.
    const magnitude = parseFixed(input.amount);
    const isReserve = input.type === "TRADE_RESERVATION" || input.type === "WITHDRAWAL_RESERVATION";
    const lockedDelta = isReserve ? magnitude : -magnitude;
    const availableDelta = -lockedDelta;
    const updatedAsset = await tx
      .update(walletBalances)
      .set({
        availableBalance: sql`${walletBalances.availableBalance} + ${signedDecimal(availableDelta)}`,
        lockedBalance: sql`${walletBalances.lockedBalance} + ${signedDecimal(lockedDelta)}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(walletBalances.walletId, input.walletId),
        eq(walletBalances.network, network),
        eq(walletBalances.asset, asset),
        sql`${walletBalances.availableBalance} + ${signedDecimal(availableDelta)} >= 0`,
        sql`${walletBalances.lockedBalance} + ${signedDecimal(lockedDelta)} >= 0`,
      ))
      .returning({ id: walletBalances.id });
    if (!updatedAsset.length) throw new Error("Insufficient available or locked balance.");

    if (asset === "USD") {
      await tx.update(wallets).set({
        availableBalance: sql`${wallets.availableBalance} + ${signedDecimal(availableDelta, 8)}`,
        lockedBalance: sql`${wallets.lockedBalance} + ${signedDecimal(lockedDelta, 8)}`,
        updatedAt: new Date(),
      }).where(and(
        eq(wallets.id, input.walletId),
        sql`${wallets.availableBalance} + ${signedDecimal(availableDelta, 8)} >= 0`,
        sql`${wallets.lockedBalance} + ${signedDecimal(lockedDelta, 8)} >= 0`,
      ));
    }
  } else {
    const updatedAsset = await tx
      .update(walletBalances)
      .set({
        availableBalance: sql`${walletBalances.availableBalance} + ${signedAmount}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(walletBalances.walletId, input.walletId),
        eq(walletBalances.network, network),
        eq(walletBalances.asset, asset),
        sql`${walletBalances.availableBalance} + ${signedAmount} >= 0`,
      ))
      .returning({ id: walletBalances.id });
    if (!updatedAsset.length) throw new Error("Insufficient available balance.");
    if (asset === "USD") {
      await tx.update(wallets).set({
        availableBalance: sql`${wallets.availableBalance} + ${signedAmount}`,
        updatedAt: new Date(),
      }).where(and(eq(wallets.id, input.walletId), sql`${wallets.availableBalance} + ${signedAmount} >= 0`));
    }
  }

  return entry;
}

/**
 * Posts a ledger entry and atomically updates the cached wallet balance.
 * Idempotent: the (referenceType, referenceId, type) unique constraint
 * means calling this twice for the same source event is a no-op on the
 * second call rather than double-crediting.
 */
export async function postLedgerEntry(db: Database, input: PostLedgerEntryInput) {
  return db.transaction((tx) => postLedgerEntryInTransaction(tx, input));
}

/**
 * Recomputes what a wallet's balance SHOULD be purely from posted ledger
 * entries, for comparison against the cached wallets.available_balance /
 * locked_balance columns. Run this on a schedule (see jobs/reconciliation.ts)
 * and alert loudly on any mismatch — that indicates a bug, not something
 * to silently "fix" by overwriting the cache.
 */
export async function computeWalletBalanceFromLedger(db: Database, walletId: string) {
  const rows = await db.query.ledgerEntries.findMany({
    where: and(eq(ledgerEntries.walletId, walletId), eq(ledgerEntries.status, "POSTED")),
  });

  let available = 0n;
  let locked = 0n;

  for (const row of rows) {
    const amt = parseFixed(row.amount, 8);
    if (row.type === "TRADE_RESERVATION" || row.type === "WITHDRAWAL_RESERVATION") {
      available -= amt < 0n ? -amt : amt;
      locked += amt < 0n ? -amt : amt;
    } else if (row.type === "TRADE_RELEASE" || row.type === "WITHDRAWAL_RELEASE") {
      available += amt < 0n ? -amt : amt;
      locked -= amt < 0n ? -amt : amt;
    } else {
      available += amt; // sign already encodes credit/debit
    }
  }

  return { available: signedDecimal(available, 8), locked: signedDecimal(locked, 8) };
}

export async function getWalletBalances(db: Database, userId: string) {
  return db.query.walletBalances.findMany({
    where: eq(walletBalances.userId, userId),
    orderBy: [desc(walletBalances.network), desc(walletBalances.asset)],
  });
}

export async function getLedgerPage(db: Database, userId: string, page: number, pageSize = 10) {
  const safePage = Math.max(0, Math.floor(page));
  const rows = await db.query.ledgerEntries.findMany({
    where: eq(ledgerEntries.userId, userId),
    orderBy: [desc(ledgerEntries.createdAt), desc(ledgerEntries.id)],
    limit: pageSize + 1,
    offset: safePage * pageSize,
  });
  return { entries: rows.slice(0, pageSize), hasMore: rows.length > pageSize, page: safePage };
}
