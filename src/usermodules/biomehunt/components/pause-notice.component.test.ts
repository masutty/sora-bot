import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { pauseNoticeComponent } from "./pause-notice.component";

async function click(result: "ended" | "not_owner" | "not_active", parts = ["7"]) {
    const calls: Array<{ pauseId: number; clicker: string }> = [];
    const replies: Array<{ content: string; flags: unknown }> = [];
    const interaction = {
        user: { id: "u1" },
        isButton: () => true,
        reply: async (p: { content: string; flags: unknown }) => {
            replies.push(p);
        },
    };
    await pauseNoticeComponent({
        endPause: async (pauseId, clicker) => {
            calls.push({ pauseId, clicker });
            return result;
        },
    }).handle(interaction as never, parts, {} as BotClient);
    return { calls, replies };
}

test("pause-notice: the paused member ends the pause and gets a private confirmation", async () => {
    const { calls, replies } = await click("ended");
    expect(calls).toEqual([{ pauseId: 7, clicker: "u1" }]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toContain("no longer paused");
});

test("pause-notice: a second click, an ended pause or a replaced pause is refused privately", async () => {
    const { replies } = await click("not_active");
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toContain("no longer active");
});

test("pause-notice: another user is refused privately", async () => {
    const { replies } = await click("not_owner");
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toContain("not yours");
});

test("pause-notice: a malformed id ends nothing", async () => {
    const { calls, replies } = await click("ended", ["x"]);
    expect(calls).toEqual([]);
    expect(replies[0]?.content).toContain("no longer active");
});
