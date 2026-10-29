import { expect, test } from "bun:test";
import { createFakeViewTransport, defineView, type ViewPayload } from "@/define";
import type { BiomeVoteBallotRow, BiomeVoteRow, NetworkBallotRow, NetworkPostRow, VoteHistoryRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { type ReviewData, takesBackLine, type VoteReviewDeps, voteReviewView } from "./vote-review.view";

const ADMIN = "admin-1";
const OWNER_ID = "owner-1";
const GUILD_ID = "g1";
const VOTE_ID = "abc12345";
const POST_ID = "net12345";

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
        finder_discord_id: "finder-1",
        server_find_count: null,
        last_seen_in_server_at: null,
        fake_reported_at: null,
        status: VoteStatus.OPEN,
        decided_by: null,
        closes_at: new Date(Date.now() + 60_000),
        created_at: new Date(),
        decided_at: null,
        ...overrides,
    };
}

const ballot = (userId: string, choice: VoteChoice): BiomeVoteBallotRow => ({
    vote_id: VOTE_ID,
    user_id: userId,
    choice,
    changed: false,
    created_at: new Date(),
});

const netBallot = (userId: string, guildId: string, choice: VoteChoice): NetworkBallotRow => ({
    post_id: POST_ID,
    discord_user_id: userId,
    guild_id: guildId,
    choice,
    changed: false,
    created_at: new Date(),
});

function makePost(overrides: Partial<NetworkPostRow> = {}): NetworkPostRow {
    return {
        id: POST_ID,
        origin_guild_id: GUILD_ID,
        origin_name: "Sol Hunters",
        origin_icon_url: null,
        invite_url: null,
        event_id: 42,
        finder_discord_id: "finder-1",
        biome: "GLITCHED",
        server_link: "https://roblox",
        server_code: "x",
        simulated: false,
        relay_guild_ids: null,
        status: "published",
        publish_at: new Date(),
        published_at: new Date(),
        vote_status: "real",
        vote_closes_at: null,
        vote_closed_by: null,
        vote_decided_by: null,
        created_at: new Date(),
        ...overrides,
    };
}

const entry = (kind: "local" | "network", from: string, to: string, by: string | null, n = 1): VoteHistoryRow => ({
    id: String(n),
    kind,
    vote_id: kind === "local" ? VOTE_ID : POST_ID,
    from_status: from,
    to_status: to,
    by_discord_id: by,
    created_at: new Date(1_700_000_000_000 + n * 1000),
});

const local = (vote = makeVote(), ballots: BiomeVoteBallotRow[] = [], history: VoteHistoryRow[] = []) => ({
    vote,
    ballots,
    history,
    finderDiscordId: "finder-1",
    rewards: { seeds: 120, xp: 40, badge: "GLITCHED" },
});

const network = (post = makePost(), ballots: NetworkBallotRow[] = [], history: VoteHistoryRow[] = []) => ({
    post,
    ballots,
    history,
    servers: [
        { guildId: GUILD_ID, name: "Sol Hunters", inviteUrl: null, real: 2, fake: 0 },
        { guildId: "g2", name: "Glitch Society", inviteUrl: "https://discord.gg/x", real: 1, fake: 1 },
    ],
    jumpLink: "https://discord.com/channels/g1/n/m",
});

function fakeDeps(world: { data: ReviewData | null }, overrides: Partial<VoteReviewDeps> = {}) {
    const calls: unknown[][] = [];
    const deps: VoteReviewDeps = {
        load: async () => (world.data ? structuredClone(world.data) : null),
        decideLocal: async (voteId, adminId, choice) => {
            calls.push(["local", voteId, adminId, choice]);
            if (world.data?.local)
                world.data.local.vote = {
                    ...world.data.local.vote,
                    status: choice === VoteChoice.REAL ? VoteStatus.ADMIN_CONFIRMED : VoteStatus.ADMIN_DENIED,
                    decided_by: adminId,
                };
            return { kind: "ok", status: VoteStatus.ADMIN_DENIED };
        },
        decideNetwork: async (postId, ownerId, choice) => {
            calls.push(["network", postId, ownerId, choice]);
            return "ok";
        },
        markReviewed: async (voteId, status, adminId) => {
            calls.push(["reviewed", voteId, status, adminId]);
        },
        isOwner: (id) => id === OWNER_ID,
        finderPanel: async (id) => {
            calls.push(["finder", id]);
            return defineView<object, void, undefined>({
                name: "test.panel",
                initial: () => ({}),
                render: () => ({ content: "panel" }),
                on: {},
            }) as never;
        },
        ...overrides,
    };
    return { deps, calls };
}

type Json = { content?: string; label?: string; custom_id?: string; disabled?: boolean; components?: unknown; accessory?: unknown };

function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return json.forEach(walk);
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

const text = (p: ViewPayload) => [p.content ?? "", ...flatten(p).map((c) => c.content ?? "")].filter(Boolean).join("\n");
const button = (p: ViewPayload, key: string) => flatten(p).find((c) => c.custom_id?.endsWith(`:${key}`));
const labels = (p: ViewPayload) => flatten(p).flatMap((c) => (c.label ? [c.label] : []));

async function open(data: ReviewData | null, viewer = ADMIN, id = VOTE_ID, opts: { back?: boolean; queue?: boolean } = {}) {
    const world = { data };
    const { deps, calls } = fakeDeps(world);
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps, opts), { id, guildId: GUILD_ID, viewerId: viewer }, viewer);
    await fake.flush();
    return { fake, calls, world };
}

test("an id this server can't see is an error", async () => {
    const { deps } = fakeDeps({ data: null });
    const fake = createFakeViewTransport();
    await expect(fake.run(voteReviewView(deps), { id: "nope", guildId: GUILD_ID, viewerId: ADMIN }, ADMIN)).rejects.toThrow(
        "No vote with that id in this server.",
    );
});

test("local tab: open vote shows the split, both sides' voters and no tabs without a Network post", async () => {
    const { fake } = await open({
        local: local(makeVote(), [ballot("r1", VoteChoice.REAL), ballot("f1", VoteChoice.FAKE)]),
        network: null,
    });
    const t = text(fake.lastPayload());
    expect(t).toContain("## Glitched\nFound by <@finder-1>");
    expect(t).toMatch(/⏳ Voting · closes <t:\d+:R> `✅ 1` `❌ 1`/);
    expect(t).toContain("**✅ Real**\n<@r1>");
    expect(t).toContain("**❌ Fake**\n<@f1>");
    expect(labels(fake.lastPayload())).toEqual(["Mark real", "Mark fake", "Finder's quality", "Jump to post"]);
});

test("local tab: no ballots says so", async () => {
    const { fake } = await open({ local: local(), network: null });
    expect(text(fake.lastPayload())).toContain("No votes yet.");
});

test("local tab: the current result greys out its Mark button", async () => {
    const { fake } = await open({ local: local(makeVote({ status: VoteStatus.COMMUNITY_FAKE })), network: null });
    expect(button(fake.lastPayload(), "markFake")?.disabled).toBe(true);
    expect(button(fake.lastPayload(), "markReal")?.disabled).toBeFalsy();
});

test("Mark fake asks first, listing what it takes back; Confirm decides and redraws", async () => {
    const { fake, calls } = await open({ local: local(makeVote({ status: VoteStatus.COMMUNITY_REAL })), network: null });
    await fake.emit(fake.click("markFake", ADMIN));
    const ask = text(fake.lastPayload());
    expect(ask).toContain("**Mark this find fake?**\n**Glitched** by <@finder-1>");
    expect(ask).toContain("-# Takes back `120 🌱`, `40 XP` and the");
    expect(calls).toEqual([]);

    await fake.emit(fake.click("confirm", ADMIN));
    expect(calls).toEqual([["local", VOTE_ID, ADMIN, VoteChoice.FAKE]]);
    expect(text(fake.lastPayload())).toContain(`❌ Marked as fake by <@${ADMIN}>`);
});

test("Cancel goes back without deciding", async () => {
    const { fake, calls } = await open({ local: local(), network: null });
    await fake.emit(fake.click("markReal", ADMIN));
    expect(text(fake.lastPayload())).toContain("**Mark this find real?**");
    await fake.emit(fake.click("cancel", ADMIN));
    expect(calls).toEqual([]);
    expect(labels(fake.lastPayload())).toContain("Mark real");
});

test("a lost race notifies", async () => {
    const world = { data: { local: local(), network: null } as ReviewData };
    const { deps } = fakeDeps(world, { decideLocal: async () => ({ kind: "already_decided" }) });
    const fake = createFakeViewTransport();
    void fake.run(voteReviewView(deps), { id: VOTE_ID, guildId: GUILD_ID, viewerId: ADMIN }, ADMIN);
    await fake.flush();
    await fake.emit(fake.click("markReal", ADMIN));
    await fake.emit(fake.click("confirm", ADMIN));
    expect(fake.notifies.at(-1)?.content).toBe("This vote was already decided.");
});

test("with a Network post: tabs, votes by server, this server's voters, and no Mark buttons for an admin", async () => {
    const ballots = [
        netBallot("a", GUILD_ID, VoteChoice.REAL),
        netBallot("b", GUILD_ID, VoteChoice.REAL),
        netBallot("c", "g2", VoteChoice.FAKE),
        netBallot("d", "g2", VoteChoice.REAL),
    ];
    const { fake } = await open({ local: local(), network: network(makePost(), ballots) });
    expect(labels(fake.lastPayload())).toContain("Network");
    await fake.emit(fake.click("tab:network", ADMIN));
    const t = text(fake.lastPayload());
    expect(t).toContain("✅ Marked as real by the Network `✅ 3` `❌ 1`");
    expect(t).toContain("**Votes by server**\n🏠 **Sol Hunters** `✅ 2` `❌ 0`\n[Glitch Society](https://discord.gg/x) `✅ 1` `❌ 1`");
    expect(t).toContain("**From this server**\n✅ <@a>, <@b>");
    expect(labels(fake.lastPayload())).not.toContain("Mark real");
});

test("Network tab: the bot owner can mark it, from a server that only has its Mirror", async () => {
    const post = makePost({ origin_guild_id: "g2", vote_status: "open", vote_closes_at: new Date(Date.now() + 60_000) });
    const { fake, calls } = await open({ local: null, network: network(post) }, OWNER_ID, POST_ID);
    const t = text(fake.lastPayload());
    expect(t).toContain("From **Sol Hunters**, found by <@finder-1>");
    expect(t).toMatch(/⏳ Voting · closes <t:\d+:R> `✅ 0` `❌ 0`\nNo votes yet\.$/);
    await fake.emit(fake.click("markFake", OWNER_ID));
    await fake.emit(fake.click("confirm", OWNER_ID));
    expect(calls).toEqual([["network", POST_ID, OWNER_ID, VoteChoice.FAKE]]);
});

test("Finder's quality opens their member panel; opened from the panel it's a Back button instead", async () => {
    const { fake, calls } = await open({ local: local(), network: null });
    await fake.emit(fake.click("finder", ADMIN));
    expect(calls).toContainEqual(["finder", "finder-1"]);
    expect(text(fake.lastPayload())).toBe("panel");

    const child = await open({ local: local(), network: null }, ADMIN, VOTE_ID, { back: true });
    expect(labels(child.fake.lastPayload())).toContain("Back");
    expect(labels(child.fake.lastPayload())).not.toContain("Finder's quality");
});

test("takesBackLine lists what a fake verdict takes back", () => {
    expect(takesBackLine({ seeds: 0, xp: 0, badge: null })).toBe("");
    expect(takesBackLine({ seeds: 1200, xp: 0, badge: null })).toBe("Takes back `1,200 🌱`.");
    expect(takesBackLine({ seeds: 5, xp: 3, badge: null })).toBe("Takes back `5 🌱` and `3 XP`.");
});

test("local tab: the History block lists 2+ changes oldest first, and is hidden for a single one", async () => {
    const vote = makeVote({ status: VoteStatus.ADMIN_DENIED, decided_by: "admin-2" });
    const history = [entry("local", "open", "community_real", null, 1), entry("local", "community_real", "admin_denied", "admin-2", 2)];
    const { fake } = await open({ local: local(vote, [], history), network: null });
    const t = text(fake.lastPayload());
    expect(t).toContain("**History**\n<t:1700000001:R> · Open → Real · the vote\n<t:1700000002:R> · Real → Fake · <@admin-2>");

    const single = await open({ local: local(vote, [], history.slice(0, 1)), network: null });
    expect(text(single.fake.lastPayload())).not.toContain("History");
});

test("Network tab: the History block says the Network, and a long history keeps the last 10", async () => {
    const history = Array.from({ length: 12 }, (_, i) => entry("network", "open", "inconclusive", i === 0 ? null : OWNER_ID, i + 1));
    const { fake } = await open({ local: null, network: network(makePost(), [], history) }, ADMIN, POST_ID);
    const t = text(fake.lastPayload());
    expect(t).toContain("**History**\n+2 earlier\n<t:1700000003:R> · Open → Inconclusive · <@owner-1>");
    expect(t).not.toContain("<t:1700000002:R>");
});

test("Looks fine: only from the queue, on a closed vote no admin decided; it records the review and returns", async () => {
    const plain = await open({ local: local(makeVote({ status: VoteStatus.TIE })), network: null });
    expect(labels(plain.fake.lastPayload())).not.toContain("Looks fine");

    const voting = await open({ local: local(), network: null }, ADMIN, VOTE_ID, { queue: true });
    expect(labels(voting.fake.lastPayload())).not.toContain("Looks fine");

    const decided = await open({ local: local(makeVote({ status: VoteStatus.ADMIN_DENIED })), network: null }, ADMIN, VOTE_ID, {
        queue: true,
    });
    expect(labels(decided.fake.lastPayload())).not.toContain("Looks fine");

    const { fake, calls } = await open({ local: local(makeVote({ status: VoteStatus.TIE })), network: null }, ADMIN, VOTE_ID, {
        back: true,
        queue: true,
    });
    expect(labels(fake.lastPayload())).toEqual(["Mark real", "Mark fake", "Looks fine", "Back", "Jump to post"]);
    await fake.emit(fake.click("looksFine", ADMIN));
    expect(calls).toEqual([["reviewed", VOTE_ID, VoteStatus.TIE, ADMIN]]);
});

test("History: a Looks fine row reads as such", async () => {
    const vote = makeVote({ status: VoteStatus.TIE });
    const history = [entry("local", "open", "tie", null, 1), entry("local", "tie", "tie", "admin-2", 2)];
    const { fake } = await open({ local: local(vote, [], history), network: null });
    expect(text(fake.lastPayload())).toContain("<t:1700000002:R> · Looks fine · <@admin-2>");
});
