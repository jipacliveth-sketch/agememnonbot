import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { resolveOrCreateIdentity } from "../src/services/identity.service";
import { postLedgerEntry, computeWalletBalanceFromLedger } from "../src/services/ledger.service";
import { walletBalances, wallets } from "../src/db/schema";

function randomTelegramId(): bigint {
  return BigInt(Math.floor(Math.random() * 1_000_000_000) + 2_000_000_000);
}

async function makeUserWithWallet() {
  const identity = await resolveOrCreateIdentity(db, { telegramUserId: randomTelegramId() });
  const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, identity.userId) });
  return { userId: identity.userId, walletId: wallet!.id };
}

describe("ledger service", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("credits available balance on a DEPOSIT entry", async () => {
    const { userId, walletId } = await makeUserWithWallet();
    const depositId = randomUUID();

    await postLedgerEntry(db, {
      userId,
      walletId,
      type: "DEPOSIT",
      amount: "100",
      referenceType: "deposit",
      referenceId: depositId,
    });

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
    expect(Number(wallet!.availableBalance)).toBe(100);
  });

  it("is idempotent — posting the same (referenceType, referenceId, type) twice does not double-credit", async () => {
    const { userId, walletId } = await makeUserWithWallet();
    const depositId = randomUUID();

    await postLedgerEntry(db, { userId, walletId, type: "DEPOSIT", amount: "50", referenceType: "deposit", referenceId: depositId });
    await postLedgerEntry(db, { userId, walletId, type: "DEPOSIT", amount: "50", referenceType: "deposit", referenceId: depositId });

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
    expect(Number(wallet!.availableBalance)).toBe(50); // NOT 100
  });

  it("moves funds from available to locked on TRADE_RESERVATION and back on TRADE_RELEASE", async () => {
    const { userId, walletId } = await makeUserWithWallet();
    const executionId = randomUUID();

    await postLedgerEntry(db, { userId, walletId, type: "DEPOSIT", amount: "200", referenceType: "deposit", referenceId: randomUUID() });
    await postLedgerEntry(db, { userId, walletId, type: "TRADE_RESERVATION", amount: "80", referenceType: "strategy_execution", referenceId: executionId });

    let wallet = await db.query.walletBalances.findFirst({ where: eq(walletBalances.walletId, walletId) });
    expect(Number(wallet!.availableBalance)).toBe(120);
    expect(Number(wallet!.lockedBalance)).toBe(80);

    await postLedgerEntry(db, { userId, walletId, type: "TRADE_RELEASE", amount: "80", referenceType: "strategy_execution", referenceId: executionId });

    wallet = await db.query.walletBalances.findFirst({ where: eq(walletBalances.walletId, walletId) });
    expect(Number(wallet!.availableBalance)).toBe(200);
    expect(Number(wallet!.lockedBalance)).toBe(0);
  });

  it("reconciles: ledger-derived balance matches the cached wallet balance", async () => {
    const { userId, walletId } = await makeUserWithWallet();

    await postLedgerEntry(db, { userId, walletId, type: "DEPOSIT", amount: "300", referenceType: "deposit", referenceId: randomUUID() });
    await postLedgerEntry(db, { userId, walletId, type: "FEE", amount: "5", referenceType: "fee", referenceId: randomUUID() });

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
    const derived = await computeWalletBalanceFromLedger(db, walletId);

    expect(Number(derived.available)).toBe(Number(wallet!.availableBalance));
    expect(Number(derived.locked)).toBe(Number(wallet!.lockedBalance));
  });
});
