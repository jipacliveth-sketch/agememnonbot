import { describe, it, expect, afterAll } from "vitest";
import { db, pool } from "../src/db/client";
import { identityMiddleware } from "../src/bot/middleware/identity.middleware";
import { resolveOrCreateIdentity } from "../src/services/identity.service";
import { BotContext } from "../src/bot/context";

function randomTelegramId(): bigint {
  return BigInt(Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000);
}

function makeFakeCtx(telegramUserId: number, presetSessionUserId?: string): BotContext {
  return {
    from: { id: telegramUserId, is_bot: false, first_name: "Test" },
    session: presetSessionUserId ? { userId: presetSessionUserId } : {},
    callbackQuery: undefined,
  } as unknown as BotContext;
}

describe("callback / identity security", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("resolves session.userId from the authenticated Telegram id, ignoring any pre-set value", async () => {
    const telegramUserId = randomTelegramId();
    const legit = await resolveOrCreateIdentity(db, { telegramUserId });

    // Simulate an attacker (or a stale session) having a DIFFERENT userId
    // already sitting in session before the middleware runs.
    const ctx = makeFakeCtx(Number(telegramUserId), "00000000-0000-0000-0000-000000000000");

    let nextCalled = false;
    await identityMiddleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    // Middleware must overwrite the preset value with the value resolved
    // from the authenticated Telegram id — never trust what was already there.
    expect(ctx.session.userId).toBe(legit.userId);
    expect(ctx.session.userId).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("two different Telegram users never resolve to the same session.userId", async () => {
    const ctxA = makeFakeCtx(Number(randomTelegramId()));
    const ctxB = makeFakeCtx(Number(randomTelegramId()));

    await identityMiddleware(ctxA, async () => {});
    await identityMiddleware(ctxB, async () => {});

    expect(ctxA.session.userId).toBeTruthy();
    expect(ctxB.session.userId).toBeTruthy();
    expect(ctxA.session.userId).not.toBe(ctxB.session.userId);
  });

  it("updates with no `from` field (e.g. channel posts) are skipped rather than resolved to a guessed user", async () => {
    const ctx = { from: undefined, session: {} } as unknown as BotContext;

    let nextCalled = false;
    await identityMiddleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(ctx.session.userId).toBeUndefined();
  });
});
