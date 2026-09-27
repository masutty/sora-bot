import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { BiomeForwardRow } from "../types";
import { checkAndForward, type ForwardServiceDeps, forwardBiome } from "./forward.service";

/** An in-memory `ForwardServiceDeps` - never touches the DB. `openVote` just records its params. */
function createFakeDeps(forward: BiomeForwardRow | null = { guild_id: "g1", biome: "GLITCHED", channel_id: "forward-channel", role_id: null }) {
    const openVoteCalls: Array<{ jumpLink: string; channelId: string; messageId: string }> = [];
    const deps: ForwardServiceDeps = {
        getForwardConfig: async () => forward,
        getBiomeCountForUser: async () => 3,
        newVoteId: () => "vote0001",
        openVote: async (params) => {
            openVoteCalls.push(params);
            return params as never;
        },
    };
    return { deps, openVoteCalls };
}

/** A minimal fake channel/client - `send` returns a fixed message id/channel id, matching what `forwardBiome` needs to open a vote. */
function fakeClient(): Client {
    const sentMessage = { id: "sent-msg-1", channelId: "forward-channel" };
    const channel = { isDMBased: () => false, isTextBased: () => true, send: async () => sentMessage };
    return { channels: { fetch: async () => channel } } as unknown as Client;
}

test("checkAndForward builds the same jump link (guild/source-channel/source-message) it always did, and passes it through to the opened vote", async () => {
    const { deps, openVoteCalls } = createFakeDeps();
    const message = { client: fakeClient(), channelId: "source-channel", id: "source-msg-1" } as unknown as Parameters<typeof checkAndForward>[0];

    await checkAndForward(
        message, "guild1", 42,
        { biome: "GLITCHED", macroType: "rare_biome", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10, deps,
    );

    expect(openVoteCalls).toHaveLength(1);
    expect(openVoteCalls[0].jumpLink).toBe("https://discord.com/channels/guild1/source-channel/source-msg-1");
});

test("forwardBiome (the refactored core) accepts an arbitrary jump link instead of deriving one from a source message - what /bh-owner simulate-biome relies on", async () => {
    const { deps, openVoteCalls } = createFakeDeps();

    await forwardBiome(
        fakeClient(), "guild1", 42,
        { biome: "GLITCHED", macroType: "simulated", eventType: "started", eventTimestamp: new Date(), serverLink: null },
        10, "https://discord.com/channels/guild1/some-channel", deps,
    );

    expect(openVoteCalls).toHaveLength(1);
    expect(openVoteCalls[0].jumpLink).toBe("https://discord.com/channels/guild1/some-channel");
});

test("forwardBiome does nothing for a non-'started' event, a null biome, or when no forward is configured - same guards as before the refactor", async () => {
    const { deps: noForwardDeps, openVoteCalls: noForwardCalls } = createFakeDeps(null);
    const { deps, openVoteCalls } = createFakeDeps();

    await forwardBiome(fakeClient(), "guild1", 42, { biome: "GLITCHED", macroType: "rare_biome", eventType: "ended", eventTimestamp: new Date(), serverLink: null }, 10, "https://discord.com/channels/guild1/x", deps);
    await forwardBiome(fakeClient(), "guild1", 42, { biome: null, macroType: null, eventType: "started", eventTimestamp: new Date(), serverLink: null }, 10, "https://discord.com/channels/guild1/x", deps);
    await forwardBiome(fakeClient(), "guild1", 42, { biome: "GLITCHED", macroType: "rare_biome", eventType: "started", eventTimestamp: new Date(), serverLink: null }, 10, "https://discord.com/channels/guild1/x", noForwardDeps);

    expect(openVoteCalls).toHaveLength(0);
    expect(noForwardCalls).toHaveLength(0);
});
