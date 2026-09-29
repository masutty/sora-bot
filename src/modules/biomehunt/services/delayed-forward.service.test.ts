import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { type BiomeVoteRow, VoteStatus } from "../types";
import { FORWARD_INFO_PREFIX } from "../views/forward-post.view";
import { type DelayedForwardDeps, type DelayedForwardJob, scheduleDelayedForward, sendDelayedForward } from "./delayed-forward.service";

/** A fake client whose one channel records every `send`. */
function fakeClient() {
    const sent: unknown[] = [];
    const channel = { isDMBased: () => false, isTextBased: () => true, send: async (payload: unknown) => sent.push(payload) };
    return { client: { channels: { fetch: async () => channel } } as unknown as Client, sent };
}

function job(client: Client, overrides: Partial<DelayedForwardJob> = {}): DelayedForwardJob {
    return {
        client,
        guildId: "g1",
        config: { guild_id: "g1", biome: "GLITCHED", channel_id: "delayed-channel", role_id: "public-role", delay_s: 30 },
        biome: "GLITCHED",
        serverLink: null,
        jumpLink: "https://discord.com/channels/g1/c/m",
        findCount: 1,
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
    };
    return { deps, scheduledMs };
}

test("scheduleDelayedForward waits the configured delay, in ms", () => {
    const { deps, scheduledMs } = fakeDeps();
    scheduleDelayedForward(job(fakeClient().client), deps);
    expect(scheduledMs).toEqual([30_000]);
});

test("sendDelayedForward sends when the find is still valid (vote open, event present)", async () => {
    const { client, sent } = fakeClient();
    await sendDelayedForward(job(client), fakeDeps({ voteStatus: VoteStatus.OPEN }).deps);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(`${FORWARD_INFO_PREFIX}:1:0`);
    expect(JSON.stringify(sent[0])).not.toContain("SIMULATED");
    expect(JSON.stringify(sent[0])).toContain("<@&public-role>");
});

test("sendDelayedForward is cancelled when the event was deleted during the delay (admin deny / fake vote)", async () => {
    const { client, sent } = fakeClient();
    await sendDelayedForward(job(client), fakeDeps({ eventExists: false }).deps);
    expect(sent).toHaveLength(0);
});

test("sendDelayedForward is cancelled on a fake/denied vote even with no event (dry-run simulation)", async () => {
    for (const status of [VoteStatus.COMMUNITY_FAKE, VoteStatus.ADMIN_DENIED]) {
        const { client, sent } = fakeClient();
        await sendDelayedForward(job(client, { eventId: null }), fakeDeps({ voteStatus: status }).deps);
        expect(sent).toHaveLength(0);
    }
});

test("sendDelayedForward dry run: sent with no pings", async () => {
    const { client, sent } = fakeClient();
    await sendDelayedForward(job(client, { eventId: null, voteId: null, dryRun: true }), fakeDeps().deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(JSON.stringify(sent[0])).toContain("SIMULATED FORWARD - TESTING ONLY");
});
