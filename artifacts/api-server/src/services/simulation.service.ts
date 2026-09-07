import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { Database } from "../db/client";
import { simulationSessions, simulationTrades, sniperUsage, wallets } from "../db/schema";
import { MemeTokenConfig, SIMULATION_CONFIG } from "../config/simulation";
import { postLedgerEntryInTransaction } from "./ledger.service";
import { parseFixed, signedDecimal } from "../lib/decimal";

export type SimulationType = "TRADE" | "SNIPER";
export type SimulationOutcome = "TAKE_PROFIT" | "STOP_LOSS" | "TIMEOUT";

export interface SimulationMarketInput {
  symbol: string;
  marketId: string;
  priceUsd: number;
  priceChange24h: number | null;
  volume24hUsd: number | null;
}

export interface SimulationTradeResult {
  exitPrice: number;
  grossPnl: number;
  feeAmount: number;
  netPnl: number;
  outcome: SimulationOutcome;
}

export function calculatePositionSize(balance: number, minPercent = SIMULATION_CONFIG.sniperMinPositionPercent, maxPercent = SIMULATION_CONFIG.sniperMaxPositionPercent, random = Math.random) {
  const percent = minPercent + (maxPercent - minPercent) * random();
  return { percent, amount: balance * percent };
}

export function calculateTradeResult(input: { entryPrice: number; exitPrice: number; positionSize: number; takeProfit: number; stopLoss: number; outcome: SimulationOutcome; feeRate?: number; maxPositivePnl?: number }) : SimulationTradeResult {
  const feeAmount = input.positionSize * (input.feeRate ?? 0.001);
  const grossPnl = Math.min(input.positionSize * ((input.exitPrice - input.entryPrice) / input.entryPrice), input.maxPositivePnl ?? Number.POSITIVE_INFINITY);
  return { exitPrice: input.exitPrice, grossPnl, feeAmount, netPnl: grossPnl - feeAmount, outcome: input.outcome };
}

export async function getActiveSimulation(db: Database, userId: string, type: SimulationType) {
  return db.query.simulationSessions.findFirst({
    where: and(eq(simulationSessions.userId, userId), eq(simulationSessions.type, type), inArray(simulationSessions.status, ["STARTING", "RUNNING"])),
    orderBy: [desc(simulationSessions.startedAt)],
  });
}

export async function createSimulation(db: Database, userId: string, type: SimulationType, market: SimulationMarketInput, runtimeMs: number, positionSize: number) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${type}`}))`);
    const active = await tx.query.simulationSessions.findFirst({
      where: and(eq(simulationSessions.userId, userId), eq(simulationSessions.type, type), inArray(simulationSessions.status, ["STARTING", "RUNNING"])),
    });
    if (active) return { session: active, created: false };

    if (type === "SNIPER") {
      const cutoff = new Date(Date.now() - SIMULATION_CONFIG.sniperWindowMs);
      const recent = await tx.query.sniperUsage.findMany({ where: and(eq(sniperUsage.userId, userId), gt(sniperUsage.usedAt, cutoff)) });
      if (recent.length >= SIMULATION_CONFIG.maxSniperUses) {
        const oldest = recent.sort((a, b) => a.usedAt.getTime() - b.usedAt.getTime())[0]!;
        const remainingMs = Math.max(0, oldest.usedAt.getTime() + SIMULATION_CONFIG.sniperWindowMs - Date.now());
        throw new Error(`SNIPER_LIMIT:${remainingMs}`);
      }
    }

    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
    if (!wallet) throw new Error("Wallet not found.");
    const startingBalance = Number(wallet.availableBalance);
    const takeProfit = market.priceUsd * (1 + (type === "SNIPER" ? 0.025 : 0.04));
    const stopLoss = market.priceUsd * (1 - (type === "SNIPER" ? 0.015 : 0.025));
    const [session] = await tx.insert(simulationSessions).values({
      userId, type, status: "RUNNING", tokenSymbol: market.symbol, marketId: market.marketId,
      entryPrice: String(market.priceUsd), currentPrice: String(market.priceUsd), positionSize: String(positionSize),
      takeProfit: String(takeProfit), stopLoss: String(stopLoss), startingBalance: String(startingBalance),
      runtimeSeconds: Math.round(runtimeMs / 1000),
    }).returning();
    if (!session) throw new Error("Unable to create simulation session.");
    if (type === "SNIPER") await tx.insert(sniperUsage).values({ userId, sessionId: session.id });
    return { session, created: true };
  });
}

export async function recordSimulationTrade(db: Database, sessionId: string, input: SimulationTradeResult, currentPrice: number) {
  return db.transaction(async (tx) => {
    const session = await tx.query.simulationSessions.findFirst({ where: eq(simulationSessions.id, sessionId) });
    if (!session || session.status !== "RUNNING") return null;
    const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.userId, session.userId) });
    if (!wallet) throw new Error("Wallet not found.");
    const [trade] = await tx.insert(simulationTrades).values({
      sessionId, userId: session.userId, tokenSymbol: session.tokenSymbol,
      entryPrice: session.entryPrice, exitPrice: String(input.exitPrice), positionSize: session.positionSize,
      grossPnl: String(input.grossPnl), feeAmount: String(input.feeAmount), netPnl: String(input.netPnl), outcome: input.outcome,
    }).returning();
    if (!trade) throw new Error("Unable to save simulated trade.");
    if (input.grossPnl > 0) {
      await postLedgerEntryInTransaction(tx, { userId: session.userId, walletId: wallet.id, type: "TRADING_PROFIT", amount: String(input.grossPnl), currency: "USD", network: "BSC", referenceType: "simulation_trade", referenceId: trade.id });
    } else if (input.grossPnl < 0) {
      await postLedgerEntryInTransaction(tx, { userId: session.userId, walletId: wallet.id, type: "TRADING_LOSS", amount: String(Math.abs(input.grossPnl)), currency: "USD", network: "BSC", referenceType: "simulation_trade", referenceId: trade.id });
    }
    if (input.feeAmount > 0) await postLedgerEntryInTransaction(tx, { userId: session.userId, walletId: wallet.id, type: "FEE", amount: String(input.feeAmount), currency: "USD", network: "BSC", referenceType: "simulation_trade_fee", referenceId: trade.id });
    const totalTrades = session.totalTrades + 1;
    const winningTrades = session.winningTrades + (input.netPnl > 0 ? 1 : 0);
    const losingTrades = session.losingTrades + (input.netPnl <= 0 ? 1 : 0);
    const takeProfits = session.takeProfits + (input.outcome === "TAKE_PROFIT" ? 1 : 0);
    const stopLosses = session.stopLosses + (input.outcome === "STOP_LOSS" ? 1 : 0);
    const grossPnl = Number(session.grossPnl) + input.grossPnl;
    const fees = Number(session.fees) + input.feeAmount;
    const netPnl = Number(session.netPnl) + input.netPnl;
    const [updated] = await tx.update(simulationSessions).set({ totalTrades, winningTrades, losingTrades, takeProfits, stopLosses, grossPnl: String(grossPnl), fees: String(fees), netPnl: String(netPnl), currentPrice: String(currentPrice), updatedAt: new Date() }).where(eq(simulationSessions.id, sessionId)).returning();
    return updated ?? null;
  });
}

export async function completeSimulation(db: Database, sessionId: string) {
  const session = await db.query.simulationSessions.findFirst({ where: eq(simulationSessions.id, sessionId) });
  if (!session) return null;
  const [completed] = await db.update(simulationSessions).set({ status: "COMPLETED", endingBalance: sql`${session.startingBalance} + ${session.netPnl}`, completedAt: new Date(), updatedAt: new Date() }).where(and(eq(simulationSessions.id, sessionId), eq(simulationSessions.status, "RUNNING"))).returning();
  return completed ?? session;
}

export async function stopSimulation(db: Database, userId: string, sessionId?: string) {
  if (!sessionId) return null;
  const [stopped] = await db.update(simulationSessions)
    .set({ status: "STOPPED", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(simulationSessions.id, sessionId), eq(simulationSessions.userId, userId), inArray(simulationSessions.status, ["STARTING", "RUNNING"])))
    .returning();
  return stopped ?? null;
}

export function formatCooldown(error: unknown) {
  if (!(error instanceof Error) || !error.message.startsWith("SNIPER_LIMIT:")) return null;
  const remainingMs = Number(error.message.slice("SNIPER_LIMIT:".length));
  return `${Math.ceil(remainingMs / 3_600_000)}h ${Math.ceil((remainingMs % 3_600_000) / 60_000)}m`;
}

export function capPositivePnl(pnl: number, startingBalance: number) {
  return Math.min(pnl, startingBalance * SIMULATION_CONFIG.maxPositivePnlPercent);
}