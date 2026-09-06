import { InputFile } from "grammy";
import { resolve } from "node:path";
import { BotContext } from "./context";

function asset(name: string) {
  return new InputFile(resolve(process.cwd(), "assets/telegram", name));
}

export async function sendWelcomeVisual(ctx: BotContext) {
  await ctx.replyWithPhoto(asset("agamemnon-welcome.png"), {
    caption: "⚔️ AGAMEMNON\nA premium command center for on-chain trading.",
  });
}

export async function sendHelmetVisual(ctx: BotContext, caption?: string) {
  await ctx.replyWithPhoto(asset("agamemnon-helmet.png"), {
    caption: caption ?? "AGAMEMNON · Strategy, discipline, execution.",
  });
}

export async function sendTokenVisual(ctx: BotContext, token: "SOL" | "USDT" | "BTC") {
  const file = token === "SOL" ? "token-sol.png" : token === "USDT" ? "token-usdt.png" : "token-btc.png";
  const caption = token === "SOL"
    ? "SOL · Solana network"
    : token === "USDT"
      ? "USDT · BSC / BEP20"
      : "BTC · Bitcoin network";
  await ctx.replyWithPhoto(asset(file), { caption });
}

export async function sendOnboardingAnimation(ctx: BotContext) {
  await ctx.replyWithAnimation(asset("agamemnon-onboarding.gif"), {
    caption: "The command center is ready.",
  });
}

export async function sendChainCheckAnimation(ctx: BotContext) {
  return ctx.replyWithAnimation(asset("chain-check.gif"), {
    caption: "Verifying the transaction on-chain…",
  });
}