import { expect, test } from "bun:test";
import type { APIContainerComponent } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import type { BiomeRewardRow, BiomeVoteBallotRow, BiomeVoteRow, UserRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { buildForwardContainer } from "../views/forward-post.view";
import {
    adminDecide, castBallot, closeDueVotes, openVote, resolveVote, type VoteServiceDeps,
} from "./biome-vote.service";

// ─── Fakes ──────────────────────────────────────────────────────────────────────────────────────

function fakeUser(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: 1, guild_id: "g1", discord_user_id: "finder", current_status: "active", last_activity_at: null,
        paused_at: null, created_at: new Date(), seeds: 0, xp: 0, flower: null, ...overrides,
    };
}

/** An in-memory `VoteServiceDeps` - never touches the DB. `calls` records every reward/revert/delete invocation. */
function createFakeDeps(seedUsers: UserRow[] = [fakeUser()]) {
    const votes = new Map<string, BiomeVoteRow>();
    const ballots = new Map<string, BiomeVoteBallotRow[]>();
    const users = new Map(seedUsers.map((u) => [u.id, u]));
    const rewardedEventIds = new Set<number>();
    const calls = {
        grantBiomeReward: [] as Array<{ guildId: string; userId: number; eventId: number; biome: string }>,
        revertBiomeRewards: [] as Array<{ userId: number; eventIds: number[] }>,
        deleteEventById: [] as number[],
        revokeOrphanedBadges: [] as Array<{ guildId: string; userId: number }>,
    };

    const deps: VoteServiceDeps = {
        insertVote: async (params) => {
            const row: BiomeVoteRow = {
                id: params.id, guild_id: params.guildId, event_id: params.eventId, finder_user_id: params.finderUserId,
                channel_id: params.channelId, message_id: params.messageId, biome: params.biome,
                status: VoteStatus.OPEN, decided_by: null, closes_at: params.closesAt, created_at: new Date(), decided_at: null,
            };
            votes.set(row.id, row);
            ballots.set(row.id, []);
            return row;
        },
        getVoteById: async (id) => votes.get(id) ?? null,
        getOpenVotesPastClose: async (now) => [...votes.values()].filter((v) => v.status === VoteStatus.OPEN && v.closes_at <= now),
        insertBallot: async (voteId, userId, choice) => {
            const list = ballots.get(voteId) ?? [];
            if (list.some((b) => b.user_id === userId)) return false;
            list.push({ vote_id: voteId, user_id: userId, choice, created_at: new Date() });
            ballots.set(voteId, list);
            return true;
        },
        getBallotsForVote: async (voteId) => ballots.get(voteId) ?? [],
        closeVote: async (voteId, status, decidedBy) => {
            const row = votes.get(voteId);
            if (!row) throw new Error("vote not found");
            const updated: BiomeVoteRow = { ...row, status, decided_by: decidedBy, decided_at: new Date() };
            votes.set(voteId, updated);
            return updated;
        },
        getUserById: async (userId) => users.get(userId) ?? null,
        getRewardsByEventIds: async (eventIds) =>
            eventIds.filter((id) => rewardedEventIds.has(id)).map((id) => ({ event_id: id }) as unknown as BiomeRewardRow),
        grantBiomeReward: async (guildId, userId, eventId, biome) => {
            calls.grantBiomeReward.push({ guildId, userId, eventId, biome });
            rewardedEventIds.add(eventId);
            return { seeds: 1500, xp: 1000, badge: null, leveledUp: false };
        },
        revertBiomeRewards: async (userId, eventIds) => {
            calls.revertBiomeRewards.push({ userId, eventIds });
            const hadAny = eventIds.some((id) => rewardedEventIds.has(id));
            for (const id of eventIds) rewardedEventIds.delete(id);
            return { seedsReverted: hadAny ? 1500 : 0, xpReverted: hadAny ? 1000 : 0, badgeCandidates: [] };
        },
        revokeOrphanedBadges: async (guildId, userId) => {
            calls.revokeOrphanedBadges.push({ guildId, userId });
            return [];
        },
        deleteEventById: async (eventId) => {
            calls.deleteEventById.push(eventId);
        },
    };

    return { deps, votes, ballots, calls, rewardedEventIds };
}

/** A `BotClient` whose only working part is `channels.fetch(...).messages.fetch(...)` -> a fake message backed by `raw` (its "current" rendered container), recording every `.edit(...)` call. */
function fakeClient(raw: APIContainerComponent | null) {
    const editCalls: Array<{ components: unknown[] }> = [];
    const message = {
        components: raw ? [{ toJSON: () => raw }] : [],
        edit: async (payload: { components: unknown[] }) => {
            editCalls.push(payload);
            return message;
        },
    };
    const channel = {
        isDMBased: () => false,
        isTextBased: () => true,
        messages: { fetch: async () => message },
    };
    const client = { channels: { fetch: async () => channel } } as unknown as BotClient;
    return { client, editCalls };
}

function openContainerJson(voteId: string, closesAt: Date): APIContainerComponent {
    return buildForwardContainer({
        biome: "GLITCHED",
        roleId: null,
        serverLink: null,
        jumpLink: "https://discord.com/channels/g/c/m",
        vote: { voteId, status: VoteStatus.OPEN, closesAt, voteCount: 0 },
    }).toJSON();
}

// ─── resolveVote (pure, exhaustive) ─────────────────────────────────────────────────────────────

test("resolveVote: no ballots -> no_votes (0x0 is NOT a tie)", () => {
    expect(resolveVote([])).toBe(VoteStatus.NO_VOTES);
});

test("resolveVote: equal non-zero real/fake -> tie", () => {
    expect(resolveVote([{ choice: VoteChoice.REAL }, { choice: VoteChoice.FAKE }])).toBe(VoteStatus.TIE);
});

test("resolveVote: more real than fake -> community_real", () => {
    expect(resolveVote([{ choice: VoteChoice.REAL }, { choice: VoteChoice.REAL }, { choice: VoteChoice.FAKE }])).toBe(VoteStatus.COMMUNITY_REAL);
});

test("resolveVote: more fake than real -> community_fake", () => {
    expect(resolveVote([{ choice: VoteChoice.FAKE }, { choice: VoteChoice.FAKE }, { choice: VoteChoice.REAL }])).toBe(VoteStatus.COMMUNITY_FAKE);
});

test("resolveVote: a single real vote -> community_real", () => {
    expect(resolveVote([{ choice: VoteChoice.REAL }])).toBe(VoteStatus.COMMUNITY_REAL);
});

test("resolveVote: a single fake vote -> community_fake", () => {
    expect(resolveVote([{ choice: VoteChoice.FAKE }])).toBe(VoteStatus.COMMUNITY_FAKE);
});

// ─── openVote ───────────────────────────────────────────────────────────────────────────────────

test("openVote persists a row with status open and closes_at = now + windowMs", async () => {
    const { deps, votes } = createFakeDeps();
    const now = new Date("2026-01-01T00:00:00Z");

    const row = await openVote(
        { voteId: "abc12345", guildId: "g1", eventId: 10, finderUserId: 1, channelId: "c1", messageId: "m1", biome: "GLITCHED", now },
        deps,
    );

    expect(row.status).toBe(VoteStatus.OPEN);
    expect(row.closes_at.getTime()).toBe(now.getTime() + 60_000);
    expect(votes.get("abc12345")).toEqual(row);
});

// ─── castBallot ─────────────────────────────────────────────────────────────────────────────────

async function seedOpenVote(deps: VoteServiceDeps, overrides: Partial<Parameters<typeof openVote>[0]> = {}) {
    return openVote(
        {
            voteId: "vote0001", guildId: "g1", eventId: 10, finderUserId: 1, channelId: "c1", messageId: "m1",
            biome: "GLITCHED", now: new Date("2026-01-01T00:00:00Z"), ...overrides,
        },
        deps,
    );
}

test("castBallot rejects the finder voting on their own find", async () => {
    const { deps } = createFakeDeps([fakeUser({ id: 1, discord_user_id: "finder-discord-id" })]);
    await seedOpenVote(deps);
    const { client } = fakeClient(null);

    const result = await castBallot(client, "vote0001", "finder-discord-id", VoteChoice.REAL, deps);

    expect(result).toEqual({ kind: "finder" });
});

test("castBallot rejects a duplicate vote - no changing an existing ballot", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    const first = await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps);
    const second = await castBallot(client, vote.id, "voter-1", VoteChoice.FAKE, deps);

    expect(first).toEqual({ kind: "ok" });
    expect(second).toEqual({ kind: "already_voted" });
});

test("castBallot rejects a vote that no longer exists, and one that's already closed", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient(null);

    expect(await castBallot(client, "no-such-id", "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "not_found" });

    await deps.closeVote(vote.id, VoteStatus.NO_VOTES, null);
    expect(await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "closed" });
});

test("castBallot on success re-edits the forward message with the updated (still-hidden) vote count", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client, editCalls } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    const result = await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps);

    expect(result).toEqual({ kind: "ok" });
    expect(editCalls).toHaveLength(1);
});

// ─── adminDecide ────────────────────────────────────────────────────────────────────────────────

test("an admin click inside the window decides immediately and closes the vote", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client, editCalls } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    const result = await adminDecide(client, vote.id, "admin-1", VoteChoice.REAL, deps);

    expect(result).toEqual({ kind: "ok", status: VoteStatus.ADMIN_CONFIRMED });
    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.ADMIN_CONFIRMED);
    expect((await deps.getVoteById(vote.id))?.decided_by).toBe("admin-1");
    expect(calls.grantBiomeReward).toHaveLength(1);
    expect(editCalls).toHaveLength(1);
});

test("adminDecide denying reverts any granted reward and deletes the event", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    await adminDecide(client, vote.id, "admin-1", VoteChoice.REAL, deps); // grants first
    await adminDecide(client, vote.id, "admin-2", VoteChoice.FAKE, deps); // then overridden to deny

    expect(calls.revertBiomeRewards).toHaveLength(1);
    expect(calls.deleteEventById).toEqual([10]);
});

test("adminDecide on a not-found vote id reports not_found", async () => {
    const { deps } = createFakeDeps();
    const { client } = fakeClient(null);

    expect(await adminDecide(client, "missing", "admin-1", VoteChoice.REAL, deps)).toEqual({ kind: "not_found" });
});

// ─── closeDueVotes ──────────────────────────────────────────────────────────────────────────────

test("closeDueVotes resolves an elapsed community_real vote, grants the reward once, and updates the message", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    await deps.insertBallot(vote.id, "voter-2", VoteChoice.REAL);
    await deps.insertBallot(vote.id, "voter-3", VoteChoice.FAKE);

    const { client, editCalls } = fakeClient(openContainerJson(vote.id, vote.closes_at));
    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);

    const closed = await deps.getVoteById(vote.id);
    expect(closed?.status).toBe(VoteStatus.COMMUNITY_REAL);
    expect(calls.grantBiomeReward).toHaveLength(1);
    expect(editCalls).toHaveLength(1);
});

test("closeDueVotes leaves a still-open vote untouched", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient(null);

    await closeDueVotes(client, new Date(vote.closes_at.getTime() - 1_000), deps);

    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.OPEN);
});

test("closeDueVotes with no votes cast closes as no_votes and grants nothing", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);

    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.NO_VOTES);
    expect(calls.grantBiomeReward).toHaveLength(0);
});

test("reward is granted exactly once even if the vote is somehow closed twice", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    const { client } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);
    // A later admin re-confirmation (e.g. `/bh-admin review`) must not double-grant.
    await adminDecide(client, vote.id, "admin-1", VoteChoice.REAL, deps);

    expect(calls.grantBiomeReward).toHaveLength(1);
});

test("admin deny after a community_real resolution reverts the granted reward", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    const { client } = fakeClient(openContainerJson(vote.id, vote.closes_at));

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);
    expect(calls.grantBiomeReward).toHaveLength(1);

    await adminDecide(client, vote.id, "admin-1", VoteChoice.FAKE, deps);

    expect(calls.revertBiomeRewards).toHaveLength(1);
    expect(calls.deleteEventById).toEqual([10]);
});
