import { Context, SessionFlavor } from "grammy";

export interface SessionData {
  // Transient multi-step flow state (deposit flow, withdrawal flow, etc.)
  // Kept minimal and short-lived — nothing financial is trusted from here;
  // it only tracks "where the user is" in a flow, e.g. which network they
  // picked. Actual amounts/addresses are re-validated server-side before
  // any balance-affecting action.
  flow?: {
    name: "deposit" | "withdrawal" | "strategy_start";
    step: string;
    data: Record<string, string>;
  };

  // Resolved once per session by the identity middleware — handlers read
  // this instead of trusting anything from callback_data.
  userId?: string;
}

export type BotContext = Context & SessionFlavor<SessionData>;
