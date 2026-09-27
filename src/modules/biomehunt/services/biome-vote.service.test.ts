import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { InsertBallotResult } from "../repository/votes.repository";
import type { BiomeRewardRow, BiomeVoteBallotRow, BiomeVoteRow, UserRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
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

/**
 * An in-memory `VoteServiceDeps` - never touches the DB. `closeVote` mimics the repository's real
 * compare-and-set contract (only writes, and returns non-null, when the row's CURRENT status still
 * matches `expectedStatus`) so tests can exercise the same race the real UPDATE...WHERE guards
 * against. `calls` records every reward/revert/delete invocation.
 */
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
                role_id: params.roleId, server_link: params.serverLink, jump_link: params.jumpLink, find_count: params.findCount,
                status: VoteStatus.OPEN, decided_by: null, closes_at: params.closesAt, created_at: new Date(), decided_at: null,
            };
            votes.set(row.id, row);
            ballots.set(row.id, []);
            return row;
        },
        getVoteById: async (id) => votes.get(id) ?? null,
        getOpenVotesPastClose: async (now) => [...votes.values()].filter((v) => v.status === VoteStatus.OPEN && v.closes_at <= now),
        insertBallot: async (voteId, userId, choice): Promise<InsertBallotResult> => {
            const vote = votes.get(voteId);
            if (!vote || vote.status !== VoteStatus.OPEN) return "closed";
            const list = ballots.get(voteId) ?? [];
            if (list.some((b) => b.user_id === userId)) return "already_voted";
            list.push({ vote_id: voteId, user_id: userId, choice, created_at: new Date() });
            ballots.set(voteId, list);
            return "inserted";
        },
        getBallotsForVote: async (voteId) => ballots.get(voteId) ?? [],
        closeVote: async (voteId, expectedStatus, status, decidedBy) => {
            const row = votes.get(voteId);
            if (!row || row.status !== expectedStatus) return null; // CAS miss - someone else already decided it
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

/** A `BotClient` whose only working part is `channels.fetch(...).messages.fetch(...)` -> a fake message, recording every `.edit(...)` call. `hasMessage: false` simulates a missing/deleted message. */
function fakeClient(hasMessage = true) {
    const editCalls: Array<{ components: unknown[] }> = [];
    const message = {
        edit: async (payload: { components: unknown[] }) => {
            editCalls.push(payload);
            return message;
        },
    };
    const channel = {
        isDMBased: () => false,
        isTextBased: () => true,
        messages: { fetch: async () => (hasMessage ? message : null) },
    };
    const client = { channels: { fetch: async () => channel } } as unknown as BotClient;
    return { client, editCalls };
}

async function seedOpenVote(deps: VoteServiceDeps, overrides: Partial<Parameters<typeof openVote>[0]> = {}) {
    return openVote(
        {
            voteId: "vote0001", guildId: "g1", eventId: 10, finderUserId: 1, channelId: "c1", messageId: "m1",
            biome: "GLITCHED", roleId: null, serverLink: null, jumpLink: "https://discord.com/channels/g/c/m",
            findCount: 3, now: new Date("2026-01-01T00:00:00Z"), ...overrides,
        },
        deps,
    );
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

test("openVote persists a row with status open, closes_at = now + windowMs, and the render inputs", async () => {
    const { deps, votes } = createFakeDeps();
    const now = new Date("2026-01-01T00:00:00Z");

    const row = await openVote(
        {
            voteId: "abc12345", guildId: "g1", eventId: 10, finderUserId: 1, channelId: "c1", messageId: "m1",
            biome: "GLITCHED", roleId: "role1", serverLink: "https://discord.gg/x", jumpLink: "https://discord.com/channels/g/c/orig",
            findCount: 2, now,
        },
        deps,
    );

    expect(row.status).toBe(VoteStatus.OPEN);
    expect(row.closes_at.getTime()).toBe(now.getTime() + 60_000);
    expect(row.role_id).toBe("role1");
    expect(row.server_link).toBe("https://discord.gg/x");
    expect(row.jump_link).toBe("https://discord.com/channels/g/c/orig");
    expect(row.find_count).toBe(2);
    expect(votes.get("abc12345")).toEqual(row);
});

// ─── castBallot ─────────────────────────────────────────────────────────────────────────────────

test("castBallot rejects the finder voting on their own find", async () => {
    const { deps } = createFakeDeps([fakeUser({ id: 1, discord_user_id: "finder-discord-id" })]);
    await seedOpenVote(deps);
    const { client } = fakeClient();

    const result = await castBallot(client, "vote0001", "finder-discord-id", VoteChoice.REAL, deps);

    expect(result).toEqual({ kind: "finder" });
});

test("castBallot rejects a duplicate vote - no changing an existing ballot", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    const first = await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps);
    const second = await castBallot(client, vote.id, "voter-1", VoteChoice.FAKE, deps);

    expect(first).toEqual({ kind: "ok" });
    expect(second).toEqual({ kind: "already_voted" });
});

test("castBallot rejects a vote that no longer exists, and one that's already closed", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    expect(await castBallot(client, "no-such-id", "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "not_found" });

    await deps.closeVote(vote.id, VoteStatus.OPEN, VoteStatus.NO_VOTES, null);
    expect(await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "closed" });
});

test("castBallot maps an insert-time 'closed' race (vote closed between the read and the insert) to kind: closed", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    // Simulate the vote closing AFTER castBallot's own getVoteById read but BEFORE its insert -
    // deps.insertBallot re-checks live status itself, same as the real atomic INSERT...WHERE EXISTS.
    const originalInsertBallot = deps.insertBallot;
    deps.insertBallot = async (voteId, userId, choice) => {
        await deps.closeVote(vote.id, VoteStatus.OPEN, VoteStatus.NO_VOTES, null);
        return originalInsertBallot(voteId, userId, choice);
    };

    expect(await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "closed" });
});

test("castBallot on success re-edits the forward message with the updated (still-hidden) vote count", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client, editCalls } = fakeClient();

    const result = await castBallot(client, vote.id, "voter-1", VoteChoice.REAL, deps);

    expect(result).toEqual({ kind: "ok" });
    expect(editCalls).toHaveLength(1);
});

// ─── adminDecide ────────────────────────────────────────────────────────────────────────────────

test("an admin click inside the window decides immediately and closes the vote", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client, editCalls } = fakeClient();

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
    const { client } = fakeClient();

    await adminDecide(client, vote.id, "admin-1", VoteChoice.REAL, deps); // grants first
    await adminDecide(client, vote.id, "admin-2", VoteChoice.FAKE, deps); // then overridden to deny

    expect(calls.revertBiomeRewards).toHaveLength(1);
    expect(calls.deleteEventById).toEqual([10]);
});

test("adminDecide on a not-found vote id reports not_found", async () => {
    const { deps } = createFakeDeps();
    const { client } = fakeClient();

    expect(await adminDecide(client, "missing", "admin-1", VoteChoice.REAL, deps)).toEqual({ kind: "not_found" });
});

test("two concurrent admin decisions on the same vote apply exactly one outcome (CAS)", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    // Both "read" the vote (still open) before either writes - simulated by closing the vote out
    // from under the second call right before its own CAS write runs.
    const originalCloseVote = deps.closeVote;
    let calls_ = 0;
    deps.closeVote = async (voteId, expectedStatus, status, decidedBy) => {
        calls_++;
        if (calls_ === 2) {
            // The "other admin" wins the race first.
            await originalCloseVote(voteId, expectedStatus, VoteStatus.ADMIN_DENIED, "admin-1");
        }
        return originalCloseVote(voteId, expectedStatus, status, decidedBy);
    };

    const [first, second] = await Promise.all([
        adminDecide(client, vote.id, "admin-1", VoteChoice.FAKE, deps),
        adminDecide(client, vote.id, "admin-2", VoteChoice.REAL, deps),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already_decided")).toHaveLength(1);
    expect(calls.revertBiomeRewards).toHaveLength(1); // the applied outcome (deny) ran exactly once
    expect(calls.grantBiomeReward).toHaveLength(0);
});

// ─── closeDueVotes ──────────────────────────────────────────────────────────────────────────────

test("closeDueVotes resolves an elapsed community_real vote, grants the reward once, and updates the message", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    await deps.insertBallot(vote.id, "voter-2", VoteChoice.REAL);
    await deps.insertBallot(vote.id, "voter-3", VoteChoice.FAKE);

    const { client, editCalls } = fakeClient();
    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);

    const closed = await deps.getVoteById(vote.id);
    expect(closed?.status).toBe(VoteStatus.COMMUNITY_REAL);
    expect(calls.grantBiomeReward).toHaveLength(1);
    expect(editCalls).toHaveLength(1);
});

test("closeDueVotes leaves a still-open vote untouched", async () => {
    const { deps } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    await closeDueVotes(client, new Date(vote.closes_at.getTime() - 1_000), deps);

    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.OPEN);
});

test("closeDueVotes with no votes cast closes as no_votes and grants nothing", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    const { client } = fakeClient();

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);

    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.NO_VOTES);
    expect(calls.grantBiomeReward).toHaveLength(0);
});

test("closeDueVotes yields (no outcome applied) when an admin already decided the vote between the scan and the write", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    const { client } = fakeClient();

    // The admin decides first, right as closeDueVotes is about to write its own resolution.
    const originalCloseVote = deps.closeVote;
    deps.closeVote = async (voteId, expectedStatus, status, decidedBy) => {
        await originalCloseVote(voteId, expectedStatus, VoteStatus.ADMIN_DENIED, "admin-1");
        return originalCloseVote(voteId, expectedStatus, status, decidedBy);
    };

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);

    expect((await deps.getVoteById(vote.id))?.status).toBe(VoteStatus.ADMIN_DENIED);
    expect(calls.grantBiomeReward).toHaveLength(0); // the community_real outcome was never applied
});

test("closeDueVotes logs and continues past one vote's failure, instead of skipping the rest of the tick", async () => {
    const { deps, calls, votes } = createFakeDeps();
    const failing = await seedOpenVote(deps, { voteId: "fails0001", eventId: 20 });
    const ok = await seedOpenVote(deps, { voteId: "ok0000002", eventId: 21 });
    await deps.insertBallot(ok.id, "voter-1", VoteChoice.REAL);

    const originalGetBallots = deps.getBallotsForVote;
    deps.getBallotsForVote = async (voteId) => {
        if (voteId === failing.id) throw new Error("boom");
        return originalGetBallots(voteId);
    };

    const { client } = fakeClient();
    await closeDueVotes(client, new Date(Math.max(failing.closes_at.getTime(), ok.closes_at.getTime()) + 1), deps);

    expect(votes.get(failing.id)?.status).toBe(VoteStatus.OPEN); // untouched by the failure
    expect(votes.get(ok.id)?.status).toBe(VoteStatus.COMMUNITY_REAL); // still processed
    expect(calls.grantBiomeReward).toHaveLength(1);
});

test("reward is granted exactly once even if the vote is somehow closed twice", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    const { client } = fakeClient();

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);
    // A later admin re-confirmation (e.g. `/bh-admin review`) must not double-grant.
    await adminDecide(client, vote.id, "admin-1", VoteChoice.REAL, deps);

    expect(calls.grantBiomeReward).toHaveLength(1);
});

test("admin deny after a community_real resolution reverts the granted reward", async () => {
    const { deps, calls } = createFakeDeps();
    const vote = await seedOpenVote(deps);
    await deps.insertBallot(vote.id, "voter-1", VoteChoice.REAL);
    const { client } = fakeClient();

    await closeDueVotes(client, new Date(vote.closes_at.getTime() + 1), deps);
    expect(calls.grantBiomeReward).toHaveLength(1);

    await adminDecide(client, vote.id, "admin-1", VoteChoice.FAKE, deps);

    expect(calls.revertBiomeRewards).toHaveLength(1);
    expect(calls.deleteEventById).toEqual([10]);
});
