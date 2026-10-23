import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type BiomeDelayedForwardRow, type BiomeForwardRow, BiomeHuntError, type BiomeVoteRow, VoteStatus } from "../types";
import { FORWARD_INFO_PREFIX } from "../views/forward-post.view";
import {
    checkAndForward,
    type DelayedForwardDeps,
    type DelayedForwardJob,
    type ForwardServiceDeps,
    forwardBiome,
    scheduleDelayedForward,
    sendDelayedForward,
    setDelayedForward,
} from "./forward.service";
import { clearLogDedup, type GuildLogDeps, guildLog } from "./guild-log.service";

/** An in-memory `ForwardServiceDeps` - never touches the DB. `openVote` just records its params. */
function createFakeDeps(
    forward: BiomeForwardRow | null = { guild_id: "g1", biome: "GLITCHED", channel_id: "forward-channel", role_id: null },
    delayed: BiomeDelayedForwardRow | null = null,
) {
    const openVoteCalls: Array<{ jumpLink: string; channelId: string; messageId: string; closesAt: Date }> = [];
    const scheduled: DelayedForwardJob[] = [];
    const deps: ForwardServiceDeps = {
        getForwardConfig: async () => forward,
        getDelayedForwardConfig: async () => delayed,
        getBiomeCountForUser: async () => 3,
        getGuildBiomeFindStats: async () => ({ count: 41, lastFoundAt: new Date(1_700_000_000_000) }),
        getUserById: async () => ({ discord_user_id: "finder-1" }) as never,
        newVoteId: () => "vote0001",
        openVote: async (params) => {
            openVoteCalls.push(params);
            return params as never;
        },
        voteWindowMs: async () => 120_000,
        scheduleDelayedForward: (job) => {
            scheduled.push(job);
        },
        log: async () => {},
    };
    return { deps, openVoteCalls, scheduled };
}

/** A minimal fake channel/client - `send` returns a fixed message id/channel id, matching what `forwardBiome` needs to open a vote. */
function fakeClient(sent: unknown[] = []): Client {
    const sentMessage = { id: "sent-msg-1", channelId: "forward-channel" };
    const channel = {
        isDMBased: () => false,
        isTextBased: () => true,
        send: async (payload: unknown) => {
            sent.push(payload);
            return sentMessage;
        },
    };
    return { channels: { fetch: async () => channel } } as unknown as Client;
}

test("checkAndForward builds the same jump link (guild/source-channel/source-message) it always did, and passes it through to the opened vote", async () => {
    const { deps, openVoteCalls } = createFakeDeps();
    const message = { client: fakeClient(), channelId: "source-channel", id: "source-msg-1" } as unknown as Parameters<
        typeof checkAndForward
    >[0];

    await checkAndForward(
        message,
        "guild1",
        42,
        { biome: "GLITCHED", macroType: "rare_biome", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10,
        deps,
    );

    expect(openVoteCalls).toHaveLength(1);
    expect(openVoteCalls[0].jumpLink).toBe("https://discord.com/channels/guild1/source-channel/source-msg-1");
});

test("forwardBiome (the refactored core) accepts an arbitrary jump link instead of deriving one from a source message - what /owner simulate-biome relies on", async () => {
    const { deps, openVoteCalls } = createFakeDeps();

    await forwardBiome(
        fakeClient(),
        "guild1",
        42,
        { biome: "GLITCHED", macroType: "simulated", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10,
        "https://discord.com/channels/guild1/some-channel",
        deps,
    );

    expect(openVoteCalls).toHaveLength(1);
    expect(openVoteCalls[0].jumpLink).toBe("https://discord.com/channels/guild1/some-channel");
});

test("forwardBiome: the vote closes after the configured local duration - the same moment the post shows", async () => {
    const { deps, openVoteCalls } = createFakeDeps();
    const sent: unknown[] = [];
    const before = Date.now();

    await forwardBiome(
        fakeClient(sent),
        "guild1",
        42,
        { biome: "GLITCHED", macroType: "simulated", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10,
        "https://discord.com/channels/guild1/some-channel",
        deps,
    );

    const closesAt = openVoteCalls[0].closesAt.getTime();
    expect(closesAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(closesAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(JSON.stringify(sent[0])).toContain(`<t:${Math.floor(closesAt / 1000)}:R>`);
});

test("forwardBiome does nothing for a non-'started' event, a null biome, or when no forward is configured - same guards as before the refactor", async () => {
    const { deps: noForwardDeps, openVoteCalls: noForwardCalls } = createFakeDeps(null);
    const { deps, openVoteCalls } = createFakeDeps();

    await forwardBiome(
        fakeClient(),
        "guild1",
        42,
        { biome: "GLITCHED", macroType: "rare_biome", eventType: "ended", eventTimestamp: new Date(), serverLink: null },
        10,
        "https://discord.com/channels/guild1/x",
        deps,
    );
    await forwardBiome(
        fakeClient(),
        "guild1",
        42,
        { biome: null, macroType: null, eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10,
        "https://discord.com/channels/guild1/x",
        deps,
    );
    await forwardBiome(
        fakeClient(),
        "guild1",
        42,
        { biome: "GLITCHED", macroType: "rare_biome", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10,
        "https://discord.com/channels/guild1/x",
        noForwardDeps,
    );

    expect(openVoteCalls).toHaveLength(0);
    expect(noForwardCalls).toHaveLength(0);
});

const DELAYED: BiomeDelayedForwardRow = {
    guild_id: "g1",
    biome: "GLITCHED",
    channel_id: "delayed-channel",
    role_id: "public-role",
    delay_s: 30,
};
const STARTED = { biome: "GLITCHED", macroType: "rare_biome", eventType: "started", eventTimestamp: new Date(), serverLink: null } as const;

test("forwardBiome schedules the delayed forward alongside the live one, carrying the live forward's vote id so a fake/denied vote can cancel it", async () => {
    const { deps, openVoteCalls, scheduled } = createFakeDeps(undefined, DELAYED);

    await forwardBiome(fakeClient(), "guild1", 42, STARTED, 10, "https://discord.com/channels/guild1/x", deps);

    expect(openVoteCalls).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
        config: DELAYED,
        biome: "GLITCHED",
        eventId: 10,
        voteId: "vote0001",
        stats: { finderDiscordId: "finder-1", findCount: 3, serverFindCount: 41, lastSeenInServerAt: new Date(1_700_000_000_000) },
    });
});

test("forwardBiome schedules a delayed forward on its own when the biome has no live forward - no vote is opened", async () => {
    const { deps, openVoteCalls, scheduled } = createFakeDeps(null, DELAYED);

    await forwardBiome(fakeClient(), "guild1", 42, STARTED, 10, "https://discord.com/channels/guild1/x", deps);

    expect(openVoteCalls).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].voteId).toBeNull();
});

test("forwardBiome schedules nothing for a non-'started' event", async () => {
    const { deps, scheduled } = createFakeDeps(null, DELAYED);

    await forwardBiome(fakeClient(), "guild1", 42, { ...STARTED, eventType: "ended" }, 10, "https://discord.com/channels/guild1/x", deps);

    expect(scheduled).toHaveLength(0);
});

test("forwardBiome dry run (null event id): pings nobody, opens no vote, and the delayed forward is flagged dry-run too", async () => {
    const { deps, openVoteCalls, scheduled } = createFakeDeps(undefined, DELAYED);
    const sent: unknown[] = [];

    await forwardBiome(fakeClient(sent), "guild1", 42, STARTED, null, "https://discord.com/channels/guild1/x", deps);

    expect(openVoteCalls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ allowedMentions: { parse: [], roles: [] } });
    expect(JSON.stringify(sent[0])).not.toContain("biomehunt:vote:");
    // No event was inserted, so both counts are bumped to read like the real find would.
    expect(scheduled[0]).toMatchObject({ dryRun: true, voteId: null, stats: { findCount: 4, serverFindCount: 42 } });
});

test("forwardBiome real find: only the forward's role may ping - the finder is named in the card but never pinged", async () => {
    const { deps } = createFakeDeps({ guild_id: "g1", biome: "GLITCHED", channel_id: "forward-channel", role_id: "role-1" });
    const sent: unknown[] = [];

    await forwardBiome(fakeClient(sent), "guild1", 42, STARTED, 10, "https://discord.com/channels/guild1/x", deps);

    expect(sent[0]).toMatchObject({ allowedMentions: { parse: [], roles: ["role-1"] } });
    expect(JSON.stringify(sent[0])).toContain("<@finder-1>");
});

test("forwardBiome: the live forward card carries the biome's flavor text", async () => {
    const { deps } = createFakeDeps();
    const sent: unknown[] = [];
    await forwardBiome(fakeClient(sent), "guild1", 42, STARTED, 10, "https://discord.com/channels/guild1/x", deps);
    expect(JSON.stringify(sent[0])).toContain("Unexpected error occurred. [Code 404]");
});

function job(client: Client, overrides: Partial<DelayedForwardJob> = {}): DelayedForwardJob {
    return {
        client,
        guildId: "g1",
        config: { guild_id: "g1", biome: "GLITCHED", channel_id: "delayed-channel", role_id: "public-role", delay_s: 30 },
        biome: "GLITCHED",
        serverLink: null,
        jumpLink: "https://discord.com/channels/g1/c/m",
        stats: { finderDiscordId: "finder-1", findCount: 1, serverFindCount: 1, lastSeenInServerAt: null },
        eventId: 10,
        voteId: "vote0001",
        dryRun: false,
        ...overrides,
    };
}

function fakeDeps(opts: { eventExists?: boolean; voteStatus?: VoteStatus | null } = {}) {
    const scheduledMs: number[] = [];
    const deps: DelayedForwardDeps = {
        eventExists: async () => opts.eventExists ?? true,
        getVoteById: async () => (opts.voteStatus ? ({ status: opts.voteStatus } as BiomeVoteRow) : null),
        schedule: (_fn, ms) => {
            scheduledMs.push(ms);
        },
        log: async () => {},
    };
    return { deps, scheduledMs };
}

test("scheduleDelayedForward waits the configured delay, in ms", () => {
    const { deps, scheduledMs } = fakeDeps();
    scheduleDelayedForward(job(fakeClient()), deps);
    expect(scheduledMs).toEqual([30_000]);
});

test("sendDelayedForward sends when the find is still valid (vote open, event present)", async () => {
    const sent: unknown[] = [];
    const client = fakeClient(sent);
    await sendDelayedForward(job(client), fakeDeps({ voteStatus: VoteStatus.OPEN }).deps);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(`${FORWARD_INFO_PREFIX}:1:0`);
    expect(JSON.stringify(sent[0])).not.toContain("SIMULATED");
    expect(JSON.stringify(sent[0])).toContain("<@&public-role>");
});

test("sendDelayedForward is cancelled when the event was deleted during the delay (admin deny / fake vote)", async () => {
    const sent: unknown[] = [];
    const client = fakeClient(sent);
    await sendDelayedForward(job(client), fakeDeps({ eventExists: false }).deps);
    expect(sent).toHaveLength(0);
});

test("sendDelayedForward is cancelled on a fake/denied vote even with no event (dry-run simulation)", async () => {
    for (const status of [VoteStatus.COMMUNITY_FAKE, VoteStatus.ADMIN_DENIED]) {
        const sent: unknown[] = [];
        const client = fakeClient(sent);
        await sendDelayedForward(job(client, { eventId: null }), fakeDeps({ voteStatus: status }).deps);
        expect(sent).toHaveLength(0);
    }
});

test("sendDelayedForward dry run: sent with no pings", async () => {
    const sent: unknown[] = [];
    const client = fakeClient(sent);
    await sendDelayedForward(job(client, { eventId: null, voteId: null, dryRun: true }), fakeDeps().deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(JSON.stringify(sent[0])).toContain("SIMULATED FORWARD - TESTING ONLY");
});

test("sendDelayedForward: the delayed card carries the biome's flavor text too", async () => {
    const sent: unknown[] = [];
    const client = fakeClient(sent);
    await sendDelayedForward(job(client), fakeDeps({ voteStatus: VoteStatus.OPEN }).deps);
    expect(JSON.stringify(sent[0])).toContain("Unexpected error occurred. [Code 404]");
});

test("forward send failure logs a warning once", async () => {
    const posted: string[] = [];
    const logDeps: GuildLogDeps = {
        getLogChannelId: async () => "log-channel",
        send: async (_channelId, payload) => {
            posted.push(JSON.stringify(payload));
        },
    };
    const failing = {
        channels: {
            fetch: async () => ({
                isDMBased: () => false,
                isTextBased: () => true,
                send: async () => {
                    throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
                },
            }),
        },
    } as unknown as Client;
    const { deps } = createFakeDeps();
    deps.log = (client, guildId, entry) => guildLog(client as BotClient, guildId, entry, logDeps);
    try {
        await forwardBiome(failing, "guild-log-once", 42, STARTED, 10, "https://discord.com/channels/guild1/x", deps);
        await forwardBiome(failing, "guild-log-once", 42, STARTED, 11, "https://discord.com/channels/guild1/x", deps);
    } finally {
        clearLogDedup("guild-log-once", "forward:forward-channel");
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Couldn't post a forward");
    expect(posted[0]).toContain("Send Messages");
    expect(posted[0]).toContain("<#forward-channel>");
});

test("setDelayedForward rejects a non-rare biome before touching the DB", async () => {
    await expect(setDelayedForward("g1", "HELL", "delayed-channel", null, 30)).rejects.toThrow(
        new BiomeHuntError("Delayed forwards are only for rare biomes."),
    );
});
