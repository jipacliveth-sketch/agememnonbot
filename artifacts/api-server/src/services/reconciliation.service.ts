import { and, eq, inArray, lt } from "drizzle-orm";
import { Database } from "../db/client";
import {
  deposits,
  ledgerEntries,
  reconciliationIssues,
  reconciliationRuns,
  walletBalances,
} from "../db/schema";
import { parseFixed, signedDecimal } from "../lib/decimal";

export async function runReconciliation(db: Database) {
  const [run] = await db.insert(reconciliationRuns).values({
    status: "RUNNING",
    summary: { startedBy: "scheduled-worker" },
  }).returning();
  if (!run) throw new Error("Unable to create reconciliation run.");
  let issueCount = 0;

  const balances = await db.query.walletBalances.findMany();
  for (const balance of balances) {
    const entries = await db.query.ledgerEntries.findMany({
      where: and(eq(ledgerEntries.walletId, balance.walletId), eq(ledgerEntries.currency, balance.asset), eq(ledgerEntries.status, "POSTED")),
    });
    let available = 0n;
    let locked = 0n;
    for (const entry of entries) {
      const amount = parseFixed(entry.amount, 12);
      if (entry.type === "TRADE_RESERVATION" || entry.type === "WITHDRAWAL_RESERVATION") {
        available -= amount < 0n ? -amount : amount;
        locked += amount < 0n ? -amount : amount;
      } else if (entry.type === "TRADE_RELEASE" || entry.type === "WITHDRAWAL_RELEASE") {
        available += amount < 0n ? -amount : amount;
        locked -= amount < 0n ? -amount : amount;
      } else {
        available += amount;
      }
    }
    const availableMismatch = signedDecimal(available, 12) !== signedDecimal(parseFixed(balance.availableBalance, 12), 12);
    const lockedMismatch = signedDecimal(locked, 12) !== signedDecimal(parseFixed(balance.lockedBalance, 12), 12);
    if (availableMismatch || lockedMismatch) {
      issueCount += 1;
      await db.insert(reconciliationIssues).values({
        runId: run.id,
        severity: "CRITICAL",
        issueType: "BALANCE_MISMATCH",
        userId: balance.userId,
        walletId: balance.walletId,
        details: {
          network: balance.network,
          asset: balance.asset,
          ledgerAvailable: signedDecimal(available, 12),
          cachedAvailable: balance.availableBalance,
          ledgerLocked: signedDecimal(locked, 12),
          cachedLocked: balance.lockedBalance,
        },
      });
    }
  }

  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const staleDeposits = await db.query.deposits.findMany({
    where: and(inArray(deposits.status, ["DETECTED", "CONFIRMING"]), lt(deposits.updatedAt, staleCutoff)),
  });
  for (const deposit of staleDeposits) {
    issueCount += 1;
    await db.insert(reconciliationIssues).values({
      runId: run.id,
      severity: "HIGH",
      issueType: "STALE_DEPOSIT",
      userId: deposit.userId,
      details: { depositId: deposit.id, status: deposit.status, txHash: deposit.txHash },
    });
  }

  await db.update(reconciliationRuns).set({
    status: issueCount ? "ISSUES_FOUND" : "COMPLETED",
    issueCount: String(issueCount),
    finishedAt: new Date(),
    summary: { checkedWalletBalances: balances.length },
  }).where(eq(reconciliationRuns.id, run.id));
  return { runId: run.id, issueCount };
}