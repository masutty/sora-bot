import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import { type BallotWriteResult, type CasualVoteRow, VoteChoice } from "../types";
import { CASUAL_VOTE_PREFIX, type CasualVoteDeps, castCasualBallot, casualVoteCard } from "./casual-vote.service";

const VOTE: CasualVoteRow = {
    id: "casual01",
    guild_id: "g1",
    channel_id: "c1",
    message_id: "m1",
    biome: "HELL",
    role_id: "role-1",
    server_link: null,
    jump_link: "https://discord.com/channels/g1/c0/m0",
    finder_discord_id: "finder-1",
    find_count: 3,
    server_find_count: 41,
    created_at: new Date(),
};

/** In-memory deps: one ballot per user, the same switch-once rule as the database query. */
function createFakeDeps(vote: CasualVoteRow | null = VOTE) {
    const ballots = new Map<string, { choice: VoteChoice; changed: boolean }>();
    const deps: CasualVoteDeps = {
        getCasualVote: async () => vote,
        insertCasualBallot: async (_voteId, userId, choice): Promise<BallotWriteResult> => {
            const existing = ballots.get(userId);
            if (!existing) {
                ballots.set(userId, { choice, changed: false });
                return "inserted";
            }
            if (existing.choice === choice) return "unchanged";
            if (existing.changed) return "change_locked";
            ballots.set(userId, { choice, changed: true });
            return "changed";
        },
        getCasualTally: async () => {
            const all = [...ballots.values()];
            return {
                real: all.filter((b) => b.choice === VoteChoice.REAL).length,
                fake: all.filter((b) => b.choice === VoteChoice.FAKE).length,
            };
        },
    };
    return { deps };
}

function fakeClient() {
    const edits: Array<{ components: unknown[] }> = [];
    const message = {
        createdAt: new Date(1_700_000_000_000),
        edit: async (payload: { components: unknown[] }) => {
            edits.push(payload);
            return message;
        },
    };
    const channel = { isDMBased: () => false, isTextBased: () => true, messages: { fetch: async () => message } };
    return { client: { channels: { fetch: async () => channel } } as unknown as BotClient, edits };
}

test("a ballot re-edits the card with the live count, on casual-vote buttons that stay enabled", async () => {
    const { deps } = createFakeDeps();
    const { client, edits } = fakeClient();

    expect(await castCasualBallot(client, VOTE.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "ok" });
    expect(await castCasualBallot(client, VOTE.id, "voter-2", VoteChoice.REAL, deps)).toEqual({ kind: "ok" });
    expect(await castCasualBallot(client, VOTE.id, "voter-3", VoteChoice.FAKE, deps)).toEqual({ kind: "ok" });

    expect(edits).toHaveLength(3);
    const last = JSON.stringify(edits[2]);
    expect(last).toContain(`${CASUAL_VOTE_PREFIX}:casual01:real`);
    expect(last).toContain('"label":"2"');
    expect(last).toContain('"label":"1"');
    expect(last).toContain('"disabled":false');
    expect(last).not.toContain("biomehunt:forward-info");
});

test("a voter can switch once and the card follows; a repeat or a second switch changes nothing", async () => {
    const { deps } = createFakeDeps();
    const { client, edits } = fakeClient();

    await castCasualBallot(client, VOTE.id, "voter-1", VoteChoice.REAL, deps);
    expect(await castCasualBallot(client, VOTE.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "unchanged" });
    expect(await castCasualBallot(client, VOTE.id, "voter-1", VoteChoice.FAKE, deps)).toEqual({ kind: "changed" });
    expect(await castCasualBallot(client, VOTE.id, "voter-1", VoteChoice.REAL, deps)).toEqual({ kind: "change_locked" });

    expect(edits).toHaveLength(2);
    const last = JSON.stringify(edits[1]);
    expect(last).toContain('"label":"0"');
    expect(last).toContain('"label":"1"');
});

test("the finder can't vote on their own find; an unknown vote is not found", async () => {
    const { client, edits } = fakeClient();
    expect(await castCasualBallot(client, VOTE.id, "finder-1", VoteChoice.REAL, createFakeDeps().deps)).toEqual({ kind: "finder" });
    expect(await castCasualBallot(client, "nope", "voter-1", VoteChoice.REAL, createFakeDeps(null).deps)).toEqual({ kind: "not_found" });
    expect(edits).toHaveLength(0);
});

test("the card is rebuilt from the stored inputs: ping and time on the title block, counts as bullets, no vote id behind '?'", () => {
    const text = JSON.stringify(casualVoteCard(VOTE, { real: 0, fake: 0 }, new Date(1_700_000_000_000)).toJSON());
    expect(text).toContain("<@&role-1> · <t:1700000000:R>");
    expect(text).toContain("Found by <@finder-1>");
    expect(text).toContain("**3rd** personal find, **41st** in this server");
    expect(text).not.toContain("biomehunt:forward-info");
});
