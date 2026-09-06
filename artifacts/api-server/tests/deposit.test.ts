import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client";
import { deposits, ledgerEntries, walletBalances, wallets } from "../src/db/schema";
import { resolveOrCreateIdentity } from "../src/services/identity.service";
import { initiatePlatformDeposit, submitDepositTxHash } from "../src/services/deposit.service";
import { registerProvider } from "../src/blockchain/registry";
import { BlockchainProvider, BlockchainTransaction } from "../src/blockchain/provider.interface";
import { PLATFORM_DEPOSIT_ASSETS } from "../src/config/deposit-addresses";

class TestProvider implements BlockchainProvider {
  readonly network = "SOLANA" as const;
  private readonly transactions = new Map<string, BlockchainTransaction>();

  setTransaction(tx: BlockchainTransaction) {
    this.transactions.set(tx.txHash, tx);
  }

  clear() {
    this.transactions.clear();
  }

  async getTransaction(txHash: string) {
    return this.transactions.get(txHash) ?? null;
  }

  async getAddressBalance() {
    return { asset: "SOL", amount: "0" };
  }

  async getConfirmations(txHash: string) {
    return this.transactions.get(txHash)?.confirmations ?? 0;
  }

  async watchAddress() {}

  async allocateDepositAddress() {
    return { address: PLATFORM_DEPOSIT_ASSETS[0].address };
  }
}

const provider = new TestProvider();
registerProvider(provider);

function tx(overrides: Partial<BlockchainTransaction> = {}): BlockchainTransaction {
  return {
    txHash: "tx-" + Math.random().toString(36).slice(2),
    fromAddress: "sender",
    toAddress: PLATFORM_DEPOSIT_ASSETS[0].address,
    asset: "SOL",
    amount: "12.5",
    confirmations: 32,
    successful: true,
    blockTime: new Date(),
    ...overrides,
  };
}

async function newUser() {
  return resolveOrCreateIdentity(db, {
    telegramUserId: BigInt(Math.floor(Math.random() * 1_000_000_000) + 4_000_000_000),
  });
}

async function newDeposit() {
  const identity = await newUser();
  const deposit = await initiatePlatformDeposit(db, {
    userId: identity.userId,
    network: "SOLANA",
    asset: "SOL",
  });
  return { identity, deposit };
}

describe("deposit verification boundary", () => {
  beforeEach(() => {
    provider.clear();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("credits a valid transaction once and remains idempotent on resubmission", async () => {
    const { identity, deposit } = await newDeposit();
    const transaction = tx({ txHash: "valid-" + deposit.id });
    provider.setTransaction(transaction);

    const first = await submitDepositTxHash(db, { depositId: deposit.id, txHash: transaction.txHash });
    const second = await submitDepositTxHash(db, { depositId: deposit.id, txHash: transaction.txHash });

    expect(first.status).toBe("CONFIRMED");
    expect(second.status).toBe("CONFIRMED");

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, identity.userId) });
    const entries = await db.query.ledgerEntries.findMany({
      where: eq(ledgerEntries.referenceId, deposit.id),
    });
    const balance = await db.query.walletBalances.findFirst({
      where: eq(walletBalances.userId, identity.userId),
    });
    expect(Number(balance!.availableBalance)).toBe(12.5);
    expect(Number(wallet!.availableBalance)).toBe(0);
    expect(entries).toHaveLength(1);
  });

  it.each([
    ["nonexistent", null, "not found"],
    ["wrong destination", tx({ toAddress: "wrong-destination" }), "Destination address mismatch"],
    ["wrong asset", tx({ asset: "USDT" }), "Asset mismatch"],
    ["failed", tx({ successful: false }), "did not succeed"],
    ["insufficient amount", tx({ amount: "0" }), "Invalid amount"],
  ])("does not credit an invalid transaction (%s)", async (_name, transaction, message) => {
    const { identity, deposit } = await newDeposit();
    if (transaction) {
      transaction.txHash = `${_name}-${deposit.id}`;
      provider.setTransaction(transaction);
    }

    await expect(
      submitDepositTxHash(db, {
        depositId: deposit.id,
        txHash: transaction?.txHash ?? `missing-${deposit.id}`,
      })
    ).rejects.toThrow(message);

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, identity.userId) });
    expect(Number(wallet!.availableBalance)).toBe(0);
  });

  it("leaves a transaction uncredited until required confirmations are reached", async () => {
    const { identity, deposit } = await newDeposit();
    const transaction = tx({ txHash: "pending-" + deposit.id, confirmations: 1 });
    provider.setTransaction(transaction);

    const result = await submitDepositTxHash(db, { depositId: deposit.id, txHash: transaction.txHash });
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, identity.userId) });

    expect(result.status).not.toBe("CONFIRMED");
    expect(Number(wallet!.availableBalance)).toBe(0);
  });

  it("rejects the same transaction hash being claimed by a second deposit", async () => {
    const first = await newDeposit();
    const second = await newDeposit();
    const transaction = tx({ txHash: `duplicate-hash-${first.deposit.id}` });
    provider.setTransaction(transaction);

    await submitDepositTxHash(db, { depositId: first.deposit.id, txHash: transaction.txHash });
    await expect(
      submitDepositTxHash(db, { depositId: second.deposit.id, txHash: transaction.txHash })
    ).rejects.toThrow("already been submitted");

    const secondWallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, second.identity.userId),
    });
    expect(Number(secondWallet!.availableBalance)).toBe(0);
  });
});