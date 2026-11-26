import { expect, test } from "bun:test";
import { type Message, PermissionFlagsBits } from "discord.js";
import { UserFacingError } from "@/define";
import { assertBotCanClear, type ClearChannel, clearCommandMessages } from "./clear";

const NOW = 10_000_000_000;
const BOT = "bot";
const NAMES = new Set(["warn", "mclear", "modlogs"]);

const msg = (id: string, author: string, content: string, ageMin = 1, replyTo?: string, bot = false) =>
    ({
        id,
        author: { id: author, bot },
        content,
        createdTimestamp: NOW - ageMin * 60_000,
        reference: replyTo ? { messageId: replyTo } : null,
    }) as unknown as Message;

async function run(messages: Message[]) {
    const deleted: string[][] = [];
    const channel: ClearChannel = {
        // Like discord.js, fetch returns a Collection (a Map), not an array.
        messages: { fetch: async () => new Map(messages.map((m) => [m.id, m])) },
        bulkDelete: async (ids) => {
            deleted.push(ids);
            return { size: ids.length };
        },
    };
    const count = await clearCommandMessages(channel, { prefix: "!", commandNames: NAMES, botId: BOT, now: NOW });
    return { count, deleted: deleted[0] ?? [] };
}

test("deletes moderation invocations by anyone and the bot's replies to them, nothing else", async () => {
    const { count, deleted } = await run([
        msg("a", "u1", "!warn @x spam"),
        msg("b", "u2", "!MODLOGS @x"),
        msg("c", BOT, "Warned", 1, "a"),
        msg("d", BOT, "unrelated bot post"),
        msg("e", BOT, "reply to chat", 1, "f"),
        msg("f", "u3", "hello there"),
        msg("g", "u3", "!ping"),
        msg("h", "u3", "!warnx"),
        msg("i", "u4", "!warn @x old", 11),
        msg("j", BOT, "late reply", 11, "a"),
        msg("k", "u1", "!mclear"),
        msg("l", "other", "forged reply", 1, "a", false),
    ]);
    expect(deleted.sort()).toEqual(["a", "b", "c", "k"]);
    expect(count).toBe(4);
});

test("another bot's command-looking message is left alone, and an empty channel deletes nothing", async () => {
    expect((await run([msg("a", "x", "!warn y", 1, undefined, true)])).deleted).toEqual([]);
    expect((await run([])).count).toBe(0);
});

test("the bot without Manage Messages gets a clear UserFacingError", () => {
    const perms = (bits: bigint[]) => ({ has: (p: bigint) => bits.includes(p) });
    expect(() => assertBotCanClear(perms([]))).toThrow(UserFacingError);
    expect(() => assertBotCanClear(null)).toThrow("I need Manage Messages here.");
    expect(() => assertBotCanClear(perms([PermissionFlagsBits.ManageMessages]))).not.toThrow();
});
