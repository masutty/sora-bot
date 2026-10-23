import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type BiomeVoteBallotRow, type BiomeVoteRow, VoteChoice, VoteStatus } from "../types";
import { type FakeFindDeps, reportFakeFind } from "./fake-find.service";
import type { GuildLogEntry } from "./guild-log.service";

function vote(overrides: Partial<BiomeVoteRow> = {}): BiomeVoteRow {
    return {
        id: "v1",
        guild_id: "g1",
        event_id: 10,
        finder_user_id: 1,
        channel_id: "fc",
        message_id: "fm",
        biome: "GLITCHED",
        role_id: null,
        server_link: null,
        jump_link: "https://discord.com/channels/g/c/m",
        find_count: null,
        finder_discord_id: "111",
        server_find_count: null,
        last_seen_in_server_at: null,
        fake_reported_at: null,
        status: VoteStatus.ADMIN_DENIED,
        decided_by: "999",
        closes_at: new Date(),
        created_at: new Date("2026-01-01T00:00:00Z"),
        decided_at: new Date(),
        ...overrides,
    };
}

function setup(opts: { flag?: boolean; macro?: boolean; ballots?: VoteChoice[]; receivedAt?: Date; fetchFails?: boolean } = {}) {
    const reported = new Set<string>();
    const macroPosts: unknown[] = [];
    const logged: GuildLogEntry[] = [];
    const deps: FakeFindDeps = {
        markFakeReported: async (id) => {
            if (reported.has(id)) return false;
            reported.add(id);
            return true;
        },
        isFlagEnabled: async () => opts.flag ?? true,
        getMacroChannelByUserId: async () => (opts.macro === false ? null : ({ channel_id: "mc" } as never)),
        getUserById: async () => null,
        getEventReceivedAt: async () => opts.receivedAt ?? null,
        getBallotsForVote: async () => (opts.ballots ?? []).map((choice) => ({ choice }) as BiomeVoteBallotRow),
        log: async (_c, _g, entry) => {
            logged.push(entry);
        },
    };
    const channel = {
        isDMBased: () => false,
        isTextBased: () => true,
        send: async (p: unknown) => {
            macroPosts.push(p);
        },
    };
    const client = {
        channels: {
            fetch: async () => {
                if (opts.fetchFails) throw new Error("Unknown Channel");
                return channel;
            },
        },
    } as unknown as BotClient;
    return { deps, client, macroPosts, logged };
}

const reverted = { seedsReverted: 120, xpReverted: 40, revoked: ["GLITCHED"] };

test("reports a fake find once per vote", async () => {
    const { deps, client, macroPosts, logged } = setup();
    await reportFakeFind(client, vote({ status: VoteStatus.COMMUNITY_FAKE, decided_by: null }), reverted, deps);
    await reportFakeFind(client, vote(), reverted, deps);
    await reportFakeFind(client, vote({ status: VoteStatus.ADMIN_CONFIRMED }), reverted, deps);
    await reportFakeFind(client, vote(), reverted, deps);
    expect(macroPosts).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "fake", footer: "fakefind · [Forward](https://discord.com/channels/g1/fc/fm)" });
    expect(logged[0].body).toContain("<@111>");
    expect(macroPosts[0]).toMatchObject({ allowedMentions: { parse: [] } });
});

test("flag off still logs", async () => {
    const { deps, client, macroPosts, logged } = setup({ flag: false });
    await reportFakeFind(client, vote(), reverted, deps);
    expect(macroPosts).toHaveLength(0);
    expect(logged).toHaveLength(1);
});

test("no macro channel still logs and a non-fake vote reports nothing", async () => {
    const { deps, client, macroPosts, logged } = setup({ macro: false });
    await reportFakeFind(client, vote({ status: VoteStatus.COMMUNITY_REAL }), reverted, deps);
    expect(logged).toHaveLength(0);
    await reportFakeFind(client, vote(), reverted, deps);
    expect(macroPosts).toHaveLength(0);
    expect(logged).toHaveLength(1);
});

test("the tally counts real and fake ballots", async () => {
    const { deps, client, logged } = setup({ ballots: [VoteChoice.FAKE, VoteChoice.FAKE, VoteChoice.REAL] });
    await reportFakeFind(client, vote({ status: VoteStatus.COMMUNITY_FAKE, decided_by: null }), reverted, deps);
    expect(logged[0].body).toContain("`✅ 1` `❌ 2`");
});

test("the quote uses the event's received_at, not the vote's created_at", async () => {
    const { deps, client, logged } = setup({ receivedAt: new Date("2026-03-01T00:00:00Z") });
    await reportFakeFind(client, vote(), reverted, deps);
    expect(logged[0].body).toContain("<t:1772323200:f>");
    expect(logged[0].body).not.toContain("<t:1767225600:f>");
});

test("falls back to the vote's created_at when the event can't be read", async () => {
    const { deps, client, logged } = setup();
    await reportFakeFind(client, vote(), reverted, deps);
    expect(logged[0].body).toContain("<t:1767225600:f>");
});

test("the macro post is a components v2 container with no pings", async () => {
    const { deps, client, macroPosts } = setup();
    await reportFakeFind(client, vote(), reverted, deps);
    const post = macroPosts[0] as { flags: number; components: unknown[]; allowedMentions: unknown };
    expect(post.flags).toBe(MessageFlags.IsComponentsV2);
    expect(post.components).toHaveLength(1);
    expect(post.allowedMentions).toEqual({ parse: [] });
});

test("a failing macro channel fetch with the flag on doesn't throw and still logs", async () => {
    const { deps, client, macroPosts, logged } = setup({ fetchFails: true });
    await reportFakeFind(client, vote(), reverted, deps);
    expect(macroPosts).toHaveLength(0);
    expect(logged).toHaveLength(1);
});
