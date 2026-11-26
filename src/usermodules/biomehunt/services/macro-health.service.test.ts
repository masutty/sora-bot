import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import type { ParsedEvent } from "../types";
import { type MacroHealthDeps, trackMacroHealth } from "./macro-health.service";

const entry = { userId: 1, guildId: "g", webhookId: "w" };

function setup(options: { flag?: boolean; claim?: boolean; sendFails?: boolean; embeds?: number; embed?: object } = {}) {
    const calls: string[] = [];
    const sent: string[] = [];
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
        embeds: Array(options.embeds ?? 1).fill(options.embed ?? {}),
        components: [],
        channel: {
            isSendable: () => true,
            send: async (payload: { allowedMentions: unknown; components: unknown }) => {
                if (options.sendFails) throw new Error("no access");
                expect(payload.allowedMentions).toEqual({ users: ["7"] });
                calls.push("send");
                sent.push(JSON.stringify(payload.components));
            },
        },
    } as unknown as Message;
    return { calls, sent, run: (parsed: ParsedEvent | null) => trackMacroHealth(message, entry, parsed, deps) };
}

const event = (eventType: ParsedEvent["eventType"]) => ({ biome: "WINDY", eventType }) as ParsedEvent;

test("a biome start or end resets the count and never warns", async () => {
    for (const eventType of ["started", "ended"] as const) {
        const { calls, run } = setup();
        await run(event(eventType));
        expect(calls).toEqual(["reset"]);
    }
});

test("a recognized macro is reported as failing, an unrecognized one as incompatible", async () => {
    const known = setup({ embed: { footer: { text: "MultiScope | v0.9.9.1-Stable" } } });
    await known.run(null);
    expect(known.sent[0]).toContain("Macro error");

    const unknown = setup({ embed: { footer: { text: "Some Macro" } } });
    await unknown.run(null);
    expect(unknown.sent[0]).toContain("Incompatible macro");
});

test("a merchant report resets the count like a biome start", async () => {
    for (const embed of [{ title: "Merchant Detected" }, { title: "🃏 Jester has arrived!" }, { description: "**Merchant:** Mari" }]) {
        const { calls, run } = setup({ embed });
        await run(null);
        expect(calls).toEqual(["reset"]);
    }
});

test("an account named after a merchant is not a merchant report", async () => {
    const { calls, run } = setup({ embed: { title: "Status Update", description: "**Account:** `mari`" } });
    await run(null);
    expect(calls).toEqual(["record", "claim", "send"]);
});

test("unreadable and untyped reads count toward the warning", async () => {
    for (const parsed of [null, event(null)]) {
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
