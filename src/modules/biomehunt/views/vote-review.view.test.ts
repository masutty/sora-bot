import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { BiomeVoteBallotRow, BiomeVoteRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { type VoteReviewDeps, voteReviewView } from "./vote-review.view";

const ADMIN = "admin-1";
const GUILD_ID = "g1";
const VOTE_ID = "abc12345";

function makeVote(overrides: Partial<BiomeVoteRow> = {}): BiomeVoteRow {
    return {
        id: VOTE_ID,
        guild_id: GUILD_ID,
        event_id: 42,
        finder_user_id: 7,
        channel_id: "chan-1",
        message_id: "msg-1",
        biome: "GLITCHED",
        role_id: null,
        server_link: null,
        jump_link: "https://discord.com/channels/1/2/3",
        find_count: null,
        status: VoteStatus.OPEN,
        decided_by: null,
        closes_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
        decided_at: null,
        ...overrides,
    };
}

function makeBallot(userId: string, choice: VoteChoice): BiomeVoteBallotRow {
    return { vote_id: VOTE_ID, user_id: userId, choice, created_at: new Date() };
}

function fakeDeps(
    overrides: Partial<VoteReviewDeps> = {},
    vote: BiomeVoteRow | null = makeVote(),
    ballots: BiomeVoteBallotRow[] = [],
): VoteReviewDeps {
    return {
        getVote: async () => vote,
        getBallots: async () => ballots,
        getFinderDiscordId: async () => "finder-1",
        adminDecide: async () => ({ kind: "ok", status: VoteStatus.ADMIN_CONFIRMED }),
        ...overrides,
    };
}

function text(payload: ViewPayload): string {
    const flatten = (node: unknown): string[] => {
        if (node === null || typeof node !== "object") return [];
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return json.flatMap(flatten);
        const obj = json as { content?: string; components?: unknown; accessory?: unknown };
        return [obj.content ?? "", ...flatten(obj.components), ...flatten(obj.accessory)].filter(Boolean);
    };
    return [(payload as { content?: string }).content ?? "", ...flatten((payload as { components?: unknown }).components)]
        .filter(Boolean)
        .join("\n");
}

test('biomehunt.vote-review: unknown id throws "No vote with that id."', async () => {
    const fake = createFakeViewTransport();
    const deps = fakeDeps({}, null);

    await expect(fake.run(voteReviewView(deps), { voteId: "nope", guildId: GUILD_ID }, ADMIN)).rejects.toThrow("No vote with that id.");
});

test("biomehunt.vote-review: a vote from another guild is treated as unknown", async () => {
    const fake = createFakeViewTransport();
    const deps = fakeDeps({}, makeVote({ guild_id: "other-guild" }));

    await expect(fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN)).rejects.toThrow("No vote with that id.");
});

test("biomehunt.vote-review: shows the finder, biome, state and Real/Fake voter mentions", async () => {
    const ballots = [makeBallot("real-voter", VoteChoice.REAL), makeBallot("fake-voter", VoteChoice.FAKE)];
    const deps = fakeDeps({}, makeVote(), ballots);
    const fake = createFakeViewTransport();

    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    const rendered = text(fake.lastPayload());
    expect(rendered).toContain("Finder: <@finder-1>");
    expect(rendered).toContain("Biome:");
    expect(rendered).toContain(":white_check_mark: : <@real-voter>");
    expect(rendered).toContain(":x: : <@fake-voter>");
});

test('biomehunt.vote-review: no ballots shows "*none*" on both sides', async () => {
    const deps = fakeDeps({}, makeVote(), []);
    const fake = createFakeViewTransport();

    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    const rendered = text(fake.lastPayload());
    expect(rendered).toContain(":white_check_mark: : *none*");
    expect(rendered).toContain(":x: : *none*");
});

test("biomehunt.vote-review: Confirm calls adminDecide(REAL) and redraws as admin-confirmed", async () => {
    const calls: Array<[string, VoteChoice]> = [];
    const deps = fakeDeps({
        adminDecide: async (adminId, choice) => {
            calls.push([adminId, choice]);
            return { kind: "ok", status: VoteStatus.ADMIN_CONFIRMED };
        },
    });
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    await fake.emit(fake.click("confirm", ADMIN));

    expect(calls).toEqual([[ADMIN, VoteChoice.REAL]]);
    expect(text(fake.lastPayload())).toContain(`Ruled real by <@${ADMIN}>`);
});

test("biomehunt.vote-review: Deny calls adminDecide(FAKE) and redraws as admin-denied", async () => {
    const calls: Array<[string, VoteChoice]> = [];
    const deps = fakeDeps({
        adminDecide: async (adminId, choice) => {
            calls.push([adminId, choice]);
            return { kind: "ok", status: VoteStatus.ADMIN_DENIED };
        },
    });
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    await fake.emit(fake.click("deny", ADMIN));

    expect(calls).toEqual([[ADMIN, VoteChoice.FAKE]]);
    expect(text(fake.lastPayload())).toContain(`Ruled fake by <@${ADMIN}>`);
});

test('biomehunt.vote-review: a CAS miss notifies "This vote was already decided." without changing the screen', async () => {
    const deps = fakeDeps({ adminDecide: async () => ({ kind: "already_decided" }) });
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    await fake.emit(fake.click("confirm", ADMIN));

    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0].content).toBe("This vote was already decided.");
    expect(text(fake.lastPayload())).not.toContain("(admin)");
});

test('biomehunt.vote-review: a vote deleted out from under the review notifies "This vote is no longer available."', async () => {
    const deps = fakeDeps({ adminDecide: async () => ({ kind: "not_found" }) });
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps), { voteId: VOTE_ID, guildId: GUILD_ID }, ADMIN);
    await fake.flush();

    await fake.emit(fake.click("deny", ADMIN));

    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0].content).toBe("This vote is no longer available.");
});
