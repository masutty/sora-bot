import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import type { ParsedEvent } from "../types";
import { type MacroHealthDeps, trackMacroHealth } from "./macro-health.service";

const entry = { userId: 1, guildId: "g", webhookId: "w" };

function setup(options: { flag?: boolean; claim?: boolean; sendFails?: boolean; embeds?: number } = {}) {
    const calls: string[] = [];
    const log = (call: string) => async () => {
        calls.push(call);
    };
    const deps: MacroHealthDeps = {
        resetUnreadEmbeds: log("reset"),
        recordUnreadEmbed: log("record"),
        claimMacroWarning: async () => {
            calls.push("claim");
            return options.claim ?? true;
        },
        releaseMacroWarning: log("release"),
        isFlagEnabled: async () => options.flag ?? true,
        sessionGapS: async () => 1200,
        discordUserId: async () => "7",
        ownerIds: ["42"],
    };
    const message = {
        embeds: Array(options.embeds ?? 1).fill({}),
        components: [],
        channel: {
            isSendable: () => true,
            send: async (payload: { allowedMentions: unknown }) => {
                if (options.sendFails) throw new Error("no access");
                expect(payload.allowedMentions).toEqual({ users: ["7"] });
                calls.push("send");
            },
        },
    } as unknown as Message;
    return { calls, run: (parsed: ParsedEvent | null) => trackMacroHealth(message, entry, parsed, deps) };
}

const event = (eventType: ParsedEvent["eventType"]) => ({ biome: "WINDY", eventType }) as ParsedEvent;

test("a biome start resets the count and never warns", async () => {
    const { calls, run } = setup();
    await run(event("started"));
    expect(calls).toEqual(["reset"]);
});

test("unreadable, ended and untyped reads all count toward the warning", async () => {
    for (const parsed of [null, event("ended"), event(null)]) {
        const { calls, run } = setup();
        await run(parsed);
        expect(calls).toEqual(["record", "claim", "send"]);
    }
});

test("nothing is sent below the thresholds or after the warning was already claimed", async () => {
    const { calls, run } = setup({ claim: false });
    await run(null);
    expect(calls).toEqual(["record", "claim"]);
});

test("with the flag off embeds are counted but the warning is not claimed", async () => {
    const { calls, run } = setup({ flag: false });
    await run(null);
    expect(calls).toEqual(["record"]);
});

test("a plain text webhook message is ignored", async () => {
    const { calls, run } = setup({ embeds: 0 });
    await run(null);
    expect(calls).toEqual([]);
});

test("a warning that cannot be sent is released", async () => {
    const { calls, run } = setup({ sendFails: true });
    await expect(run(null)).rejects.toThrow("no access");
    expect(calls).toEqual(["record", "claim", "release"]);
});
