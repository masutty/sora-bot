import { expect, test } from "bun:test";
import { type BotBanGateDeps, type BotModerationDeps, banFromBot, botBanReply, buildBannedReply, unbanFromBot } from "./bot-ban";
import { setCachedBans } from "./bot-ban-cache";

const text = (payload: unknown) => JSON.stringify(payload);

function deps(ban: { reason: string | null } | null, opts: { owners?: string[]; fails?: boolean } = {}): BotBanGateDeps {
    return {
        getBotBan: async (userId) => {
            if (opts.fails) throw new Error("db down");
            return ban && userId === "banned"
                ? { discord_user_id: userId, reason: ban.reason, banned_by: "o1", created_at: new Date() }
                : null;
        },
        ownerIds: () => opts.owners ?? ["o1"],
    };
}

test("buildBannedReply: says the user is banned, with the reason when there is one", () => {
    expect(text(buildBannedReply({ reason: "Spamming fake biomes" }))).toContain("You are banned from using this bot.");
    expect(text(buildBannedReply({ reason: "Spamming fake biomes" }))).toContain("Reason: Spamming fake biomes");
    expect(text(buildBannedReply({ reason: null }))).not.toContain("Reason:");
});

test("botBanReply: a banned user gets the error reply, anyone else nothing", async () => {
    expect(await botBanReply("banned", deps({ reason: "x" }))).not.toBeNull();
    expect(await botBanReply("someone", deps({ reason: "x" }))).toBeNull();
});

test("botBanReply: a bot owner is never blocked, even if banned", async () => {
    expect(await botBanReply("banned", deps({ reason: "x" }, { owners: ["banned"] }))).toBeNull();
});

test("botBanReply: if the ban lookup fails, the user is let through instead of breaking every command", async () => {
    expect(await botBanReply("banned", deps({ reason: "x" }, { fails: true }))).toBeNull();
});

function moderationDeps() {
    const banned = new Map<string, string | null>();
    const history: Array<{ userId: string; action: string; reason: string | null; by: string }> = [];
    const deps: BotModerationDeps = {
        insertBotBan: async (userId, reason) => {
            if (banned.has(userId)) return false;
            banned.set(userId, reason);
            return true;
        },
        deleteBotBan: async (userId) => banned.delete(userId),
        insertBotPunishment: async (userId, action, reason, by) => {
            history.push({ userId, action, reason, by });
        },
        ownerIds: () => ["o1"],
    };
    return { deps, history };
}

test("banFromBot: bans, records it in the history, and the gate blocks the user right away", async () => {
    setCachedBans([]);
    const { deps, history } = moderationDeps();
    expect(await banFromBot("u1", "Spam", "o1", deps)).toBe(true);
    expect(history).toEqual([{ userId: "u1", action: "ban", reason: "Spam", by: "o1" }]);
    expect(text(await botBanReply("u1"))).toContain("Reason: Spam");
    expect(await banFromBot("u1", "Again", "o1", deps)).toBe(false);
    expect(history).toHaveLength(1);
});

test("unbanFromBot: lifts it, records it, and the gate lets the user through again", async () => {
    setCachedBans([]);
    const { deps, history } = moderationDeps();
    await banFromBot("u1", null, "o1", deps);
    expect(await unbanFromBot("u1", "o1", deps)).toBe(true);
    expect(history.map((h) => h.action)).toEqual(["ban", "unban"]);
    expect(await botBanReply("u1")).toBeNull();
    expect(await unbanFromBot("u1", "o1", deps)).toBe(false);
});

test("banFromBot refuses to ban a bot owner", async () => {
    const { deps } = moderationDeps();
    await expect(banFromBot("o1", null, "o1", deps)).rejects.toThrow("bot owner");
});
