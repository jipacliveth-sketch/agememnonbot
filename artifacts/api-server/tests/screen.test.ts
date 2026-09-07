import { describe, expect, it } from "vitest";
import { renderScreen } from "../src/bot/lib/screen";
import { BotContext } from "../src/bot/context";

function makePhotoCallbackContext(calls: string[]): BotContext {
  return {
    callbackQuery: { message: { photo: [], message_id: 42 } },
    chat: { id: 7 },
    session: { flow: { name: "trade", step: "MENU", data: {} } },
    editMessageCaption: async () => { calls.push("caption"); },
    editMessageText: async () => { calls.push("text"); },
    reply: async () => { calls.push("reply"); },
  } as unknown as BotContext;
}

describe("Telegram screen rendering", () => {
  it("updates trade photo screens in place instead of sending another message", async () => {
    const calls: string[] = [];

    await renderScreen(makePhotoCallbackContext(calls), "SCANNING", undefined);

    expect(calls).toEqual(["caption"]);
  });
});
