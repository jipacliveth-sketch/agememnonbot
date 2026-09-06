import { eq, sql } from "drizzle-orm";
import { Database } from "../db/client";
import { users, telegramIdentities, wallets, userSettings } from "../db/schema";

export interface TelegramContext {
  telegramUserId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
}

export interface ResolvedIdentity {
  userId: string;
  accountReference: string;
  isNewAccount: boolean;
}

function generateAccountReference(): string {
  // Human-friendly reference like "AGM-8F31A" — not used for security,
  // purely cosmetic/display. Internal id remains the uuid.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `AGM-${suffix}`;
}

/**
 * Core identity resolution used by every "/start" and every authenticated
 * bot interaction. Telegram user id is the identity anchor: same Telegram
 * account => same internal user, regardless of device/session.
 *
 * This must run inside the caller's request flow BEFORE any other
 * service call that takes a userId — callers should never accept a
 * userId from callback data, only from this resolution.
 */
export async function resolveOrCreateIdentity(
  db: Database,
  ctx: TelegramContext
): Promise<ResolvedIdentity> {
  const existing = await db.query.telegramIdentities.findFirst({
    where: eq(telegramIdentities.telegramUserId, ctx.telegramUserId),
  });

  if (existing) {
    await db
      .update(telegramIdentities)
      .set({
        lastInteractionAt: new Date(),
        username: ctx.username,
        firstName: ctx.firstName,
        lastName: ctx.lastName,
      })
      .where(eq(telegramIdentities.id, existing.id));

    const user = await db.query.users.findFirst({
      where: eq(users.id, existing.userId),
    });
    if (!user) {
      throw new Error(`Data integrity error: telegram_identity ${existing.id} references missing user`);
    }

    return {
      userId: user.id,
      accountReference: user.accountReference,
      isNewAccount: false,
    };
  }

  // Serialize by Telegram id so two concurrent /start updates cannot create
  // two users or two wallets for the same Telegram account.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.telegramUserId.toString()}))`);
    const insideTransaction = await tx.query.telegramIdentities.findFirst({
      where: eq(telegramIdentities.telegramUserId, ctx.telegramUserId),
    });
    if (insideTransaction) {
      const user = await tx.query.users.findFirst({ where: eq(users.id, insideTransaction.userId) });
      if (!user) throw new Error(`Data integrity error: identity ${insideTransaction.id} references missing user`);
      await tx.update(telegramIdentities).set({
        lastInteractionAt: new Date(),
        username: ctx.username,
        firstName: ctx.firstName,
        lastName: ctx.lastName,
      }).where(eq(telegramIdentities.id, insideTransaction.id));
      return { userId: user.id, accountReference: user.accountReference, isNewAccount: false };
    }

    const [user] = await tx
      .insert(users)
      .values({ accountReference: generateAccountReference() })
      .returning();

    await tx.insert(telegramIdentities).values({
      userId: user.id,
      telegramUserId: ctx.telegramUserId,
      username: ctx.username,
      firstName: ctx.firstName,
      lastName: ctx.lastName,
      languageCode: ctx.languageCode,
    });

    await tx.insert(wallets).values({
      userId: user.id,
    });
    await tx.insert(userSettings).values({ userId: user.id });

    return {
      userId: user.id,
      accountReference: user.accountReference,
      isNewAccount: true,
    };
  });
}

/**
 * Resolves the authenticated user for an already-known Telegram user id.
 * Used by every subsequent handler after /start — throws if somehow
 * called for an identity that was never created (should not happen in
 * normal flow since the middleware always resolves-or-creates first).
 */
export async function getUserByTelegramId(db: Database, telegramUserId: bigint) {
  const identity = await db.query.telegramIdentities.findFirst({
    where: eq(telegramIdentities.telegramUserId, telegramUserId),
  });
  if (!identity) return null;

  return db.query.users.findFirst({ where: eq(users.id, identity.userId) });
}
