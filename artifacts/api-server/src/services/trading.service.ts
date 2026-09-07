import { and, eq, inArray } from "drizzle-orm";
import { Database } from "../db/client";
import { strategies, strategyExecutions, wallets } from "../db/schema";
import { tradingEngineAdapter } from "../trading-engine/adapter";
import { parseFixed } from "../lib/decimal";
import { postLedgerEntryInTransaction, postLedgerEntry } from "./ledger.service";
import { enqueueNotification } from "./notification.service";

const ACTIVE_STATUSES: ("STARTING" | "ACTIVE" | "STOPPING")[] = ["STARTING", "ACTIVE", "STOPPING"];
const TRADING_CURRENCY = "USD";
const TRADING_NETWORK = "BSC" as const;

export interface StrategyStartOptions {
  marketId?: string;
  tokenSymbol?: string;
  runtimeMinutes?: 5 | 10 | 15;
}

export async function startPlatformStrategy(db: Database, userId: string, slug: string, options: StrategyStartOptions = {}) {
  const strategy = await db.query.strategies.findFirst({
    where: and(eq(strategies.slug, slug), eq(strategies.status, "AVAILABLE"), eq(strategies.enabled, true)),
  });
  if (!strategy) throw new Error("This strategy is unavailable.");
  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
  if (!wallet) throw new Error("Wallet not found.");
  if (parseFixed(wallet.availableBalance, 8) < parseFixed(strategy.minimumBalance, 8)) {
    throw new Error("Insufficient available balance.");
  }

  const existing = await db.query.strategyExecutions.findFirst({
    where: and(eq(strategyExecutions.userId, userId), eq(strategyExecutions.strategyId, strategy.id), inArray(strategyExecutions.status, ACTIVE_STATUSES)),
  });
  if (existing) throw new Error("This strategy is already active.");

  const result = await db.transaction(async (tx) => {
    const [execution] = await tx.insert(strategyExecutions).values({
      userId,
      strategyId: strategy.id,
      allocatedAmount: strategy.minimumBalance,
      status: "STARTING",
    }).returning();
    if (!execution) throw new Error("Unable to create strategy execution.");
    await postLedgerEntryInTransaction(tx, {
      userId,
      walletId: wallet.id,
      type: "TRADE_RESERVATION",
      amount: strategy.minimumBalance,
      currency: TRADING_CURRENCY,
      network: TRADING_NETWORK,
      referenceType: "strategy_execution",
      referenceId: execution.id,
    });
    return execution;
  });

  try {
    const engineExecution = await tradingEngineAdapter.startStrategy({
      userId,
      strategyId: strategy.id,
      allocatedAmount: strategy.minimumBalance,
      ...options,
    });
    const [active] = await db.update(strategyExecutions).set({
      status: engineExecution.status === "ACTIVE" ? "ACTIVE" : "STARTING",
      engineExecutionRef: engineExecution.engineExecutionRef,
    }).where(eq(strategyExecutions.id, result.id)).returning();
    await enqueueNotification(db, {
      userId,
      type: "STRATEGY_STARTED",
      payload: { strategyName: strategy.name },
      dedupeKey: `strategy-started:${result.id}`,
    });
    return active;
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx.update(strategyExecutions).set({ status: "FAILED", stoppedAt: new Date() }).where(eq(strategyExecutions.id, result.id));
      await postLedgerEntryInTransaction(tx, {
        userId,
        walletId: wallet.id,
        type: "TRADE_RELEASE",
        amount: strategy.minimumBalance,
        currency: "USD",
        network: TRADING_NETWORK,
        referenceType: "strategy_execution",
        referenceId: result.id,
      });
    });
    throw error;
  }
}

export async function stopPlatformStrategy(db: Database, userId: string, executionId: string) {
  const execution = await db.query.strategyExecutions.findFirst({
    where: and(eq(strategyExecutions.id, executionId), eq(strategyExecutions.userId, userId)),
  });
  if (!execution) throw new Error("Strategy execution not found.");
  if (execution.status === "STOPPED" || execution.status === "FAILED") return execution;
  if (!execution.engineExecutionRef) throw new Error("Strategy has not been acknowledged by the engine.");
  await db.update(strategyExecutions).set({ status: "STOPPING" }).where(and(eq(strategyExecutions.id, executionId), inArray(strategyExecutions.status, ACTIVE_STATUSES)));
  await tradingEngineAdapter.stopStrategy(execution.engineExecutionRef);
  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
  if (!wallet) throw new Error("Wallet not found.");
  const [stopped] = await db.transaction(async (tx) => {
    await postLedgerEntryInTransaction(tx, {
      userId,
      walletId: wallet.id,
      type: "TRADE_RELEASE",
      amount: execution.allocatedAmount,
      currency: TRADING_CURRENCY,
      network: TRADING_NETWORK,
      referenceType: "strategy_execution",
      referenceId: execution.id,
    });
    return tx.update(strategyExecutions).set({ status: "STOPPED", stoppedAt: new Date() })
      .where(eq(strategyExecutions.id, executionId)).returning();
  });
  await enqueueNotification(db, {
    userId,
    type: "STRATEGY_STOPPED",
    payload: { strategyName: execution.strategyId },
    dedupeKey: `strategy-stopped:${execution.id}`,
  });
  return stopped;
}