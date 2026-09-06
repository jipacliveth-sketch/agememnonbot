import { describe, it, expect, afterAll } from "vitest";
import { db, pool } from "../src/db/client";
import { resolveOrCreateIdentity } from "../src/services/identity.service";
import { wallets } from "../src/db/schema";
import { eq } from "drizzle-orm";

// Requires DATABASE_URL to point at a real, migrated Postgres instance.
// Uses randomized telegram ids per run so repeated test runs don't collide
// with leftover rows from a previous run.
function randomTelegramId(): bigint {
  return BigInt(Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000);
}

describe("identity resolution", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates a new account + wallet on first /start", async () => {
    const telegramUserId = randomTelegramId();

    const result = await resolveOrCreateIdentity(db, {
      telegramUserId,
      username: "new_user_test",
      firstName: "Test",
    });

    expect(result.isNewAccount).toBe(true);
    expect(result.userId).toBeTruthy();
    expect(result.accountReference).toMatch(/^AGM-/);

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, result.userId) });
    expect(wallet).toBeTruthy();
    expect(Number(wallet!.availableBalance)).toBe(0);
  });

  it("resolves the SAME internal account on repeated /start for the same telegram id", async () => {
    const telegramUserId = randomTelegramId();

    const first = await resolveOrCreateIdentity(db, { telegramUserId, username: "repeat_user" });
    const second = await resolveOrCreateIdentity(db, { telegramUserId, username: "repeat_user" });

    expect(second.isNewAccount).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.accountReference).toBe(first.accountReference);
  });

  it("does not create a duplicate account for the same telegram id logging in from a different session", async () => {
    const telegramUserId = randomTelegramId();

    // Simulates "another phone" / "Telegram Desktop" — same telegramUserId,
    // slightly different metadata (e.g. username changed).
    const first = await resolveOrCreateIdentity(db, { telegramUserId, username: "old_username" });
    const second = await resolveOrCreateIdentity(db, { telegramUserId, username: "new_username" });

    expect(second.userId).toBe(first.userId);

    const walletCount = await db.query.wallets.findMany({ where: eq(wallets.userId, first.userId) });
    expect(walletCount.length).toBe(1); // exactly one wallet, never duplicated
  });

  it("gives two different telegram users two different internal accounts", async () => {
    const a = await resolveOrCreateIdentity(db, { telegramUserId: randomTelegramId() });
    const b = await resolveOrCreateIdentity(db, { telegramUserId: randomTelegramId() });

    expect(a.userId).not.toBe(b.userId);
  });
});
