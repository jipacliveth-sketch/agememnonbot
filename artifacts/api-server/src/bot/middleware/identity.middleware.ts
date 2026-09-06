import { NextFunction } from "grammy";
import { db } from "../../db/client";
import { resolveOrCreateIdentity } from "../../services/identity.service";
import { BotContext } from "../context";

/**
 * Runs before every handler. Resolves ctx.session.userId from the
 * authenticated Telegram update — this is the ONLY place userId gets
 * set on the session. Handlers must read ctx.session.userId, never a
 * userId embedded in callback_data, since callback_data is attacker-
 * controlled input from the user's own client.
 */
export async function identityMiddleware(ctx: BotContext, next: NextFunction) {
  const from = ctx.from;
  if (!from) {
    return; // updates without a `from` (e.g. channel posts) aren't user actions
  }

  const identity = await resolveOrCreateIdentity(db, {
    telegramUserId: BigInt(from.id),
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    languageCode: from.language_code,
  });

  ctx.session.userId = identity.userId;
  (ctx as any).isNewAccount = identity.isNewAccount;

  await next();
}
