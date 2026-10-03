import { expect, test } from "bun:test";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { InsertNetworkAlertParams } from "../repository/network-posts.repository";
import {
    type NetworkBallotRow,
    type NetworkGuildRow,
    type NetworkMirrorRow,
    type NetworkPostRow,
    NetworkStatus,
    VoteChoice,
} from "../types";
import {
    castNetworkBallot,
    closeDueNetworkVotes,
    closeNetworkVote,
    type NetworkVoteDeps,
    resolveNetworkVote,
} from "./network-vote.service";

const T0 = new Date("2026-10-02T12:00:00Z");
const REAL = VoteChoice.REAL;
const FAKE = VoteChoice.FAKE;

const b = (guild_id: string, choice: VoteChoice) => ({ guild_id, choice });

test("resolveNetworkVote: each server is the majority of its members and needs 2 decided servers", () => {
    expect(resolveNetworkVote([b("g1", FAKE), b("g1", FAKE), b("g1", REAL), b("g2", FAKE)])).toEqual({
        status: "fake",
        scoreboard: { servers: { real: 0, fake: 2 }, people: { real: 1, fake: 3 } },
    });
});

test("resolveNetworkVote: a big server counts once - two small servers outvote it", () => {
    const ballots = [b("big", FAKE), b("big", FAKE), b("big", FAKE), b("big", FAKE), b("s1", REAL), b("s2", REAL)];
    expect(resolveNetworkVote(ballots).status).toBe("real");
});

test("resolveNetworkVote: a tied server abstains", () => {
    const result = resolveNetworkVote([b("g1", REAL), b("g1", FAKE), b("g2", REAL), b("g3", REAL)]);
    expect(result.scoreboard.servers).toEqual({ real: 2, fake: 0 });
    expect(result.status).toBe("real");
});

test("resolveNetworkVote: fewer than 2 decided servers, or a server tie, is inconclusive", () => {
    expect(resolveNetworkVote([]).status).toBe("inconclusive");
    expect(resolveNetworkVote([b("g1", FAKE), b("g1", FAKE)]).status).toBe("inconclusive");
    expect(resolveNetworkVote([b("g1", FAKE), b("g2", REAL)]).status).toBe("inconclusive");
});

function post(overrides: Partial<NetworkPostRow> = {}): NetworkPostRow {
    return {
        id: "p1",
        origin_guild_id: "gA",
        origin_name: "Guild A",
        origin_icon_url: null,
        invite_url: null,
        event_id: 1,
        finder_discord_id: "finder",
        biome: "GLITCHED",
        server_link: "https://www.roblox.com/share?code=C&type=Server",
        server_code: "C",
        simulated: false,
        relay_guild_ids: null,
        status: "published",
        publish_at: T0,
        published_at: T0,
        vote_status: "open",
        vote_closes_at: new Date(T0.getTime() + 60_000),
        vote_closed_by: null,
        created_at: T0,
        ...overrides,
    };
}

function guildRow(guildId: string, status = NetworkStatus.MEMBER): NetworkGuildRow {
    return {
        guild_id: guildId,
        status,
        forced: false,
        network_channel_id: `net-${guildId}`,
        staff_channel_id: "staff",
        staff_role_id: "role",
        announce_role_id: null,
        invite_url: null,
        requested_at: null,
        approved_at: null,
        decided_by: null,
        low_activity_checks: 0,
        last_activity_check: null,
        created_at: T0,
        updated_at: T0,
    };
}

function createFakeDeps(initial: NetworkPostRow = post(), opts: { bannedUsers?: string[]; guilds?: NetworkGuildRow[] } = {}) {
    let current = initial;
    const ballots: NetworkBallotRow[] = [];
    const guilds = new Map((opts.guilds ?? [guildRow("gA"), guildRow("gB"), guildRow("gC")]).map((g) => [g.guild_id, g]));
    const mirrors: NetworkMirrorRow[] = [
        { post_id: "p1", guild_id: "gB", channel_id: "net-gB", message_id: "m1" },
        { post_id: "p1", guild_id: "gC", channel_id: "net-gC", message_id: "m2" },
    ];
    let clock = T0;
    const calls = {
        edits: [] as Array<{ mirror: NetworkMirrorRow; payload: MessageEditOptions }>,
        staff: [] as Array<{ guildId: string; content: string }>,
        ownerDms: [] as MessageCreateOptions[],
        alerts: [] as InsertNetworkAlertParams[],
    };
    const deps: NetworkVoteDeps = {
        getNetworkPost: async (id) => (id === current.id ? current : null),
        getNetworkGuild: async (id) => guilds.get(id) ?? null,
        isNetworkBanned: async (kind, id) => kind === "user" && (opts.bannedUsers ?? []).includes(id),
        insertNetworkBallot: async (postId, userId, guildId, choice) => {
            if (current.vote_status !== "open") return "closed";
            if (ballots.some((x) => x.post_id === postId && x.discord_user_id === userId)) return "already_voted";
            ballots.push({ post_id: postId, discord_user_id: userId, guild_id: guildId, choice, created_at: clock });
            return "inserted";
        },
        getNetworkBallots: async () => ballots,
        getDueOpenNetworkVotes: async (now) =>
            current.vote_status === "open" && current.vote_closes_at && current.vote_closes_at <= now ? [current] : [],
        closeNetworkVoteRow: async (_id, status, closedBy) => {
            if (current.vote_status !== "open") return null;
            current = { ...current, vote_status: status, vote_closed_by: closedBy };
            return current;
        },
        getNetworkMirrors: async () => mirrors,
        editMirror: async (mirror, payload) => {
            calls.edits.push({ mirror, payload });
        },
        notifyStaff: async (row, content) => {
            calls.staff.push({ guildId: row.guild_id, content });
        },
        notifyOwners: async (payload) => {
            calls.ownerDms.push(payload);
        },
        insertNetworkAlert: async (a) => {
            calls.alerts.push(a);
        },
        now: () => clock,
    };
    return {
        deps,
        ballots,
        calls,
        current: () => current,
        setClock: (d: Date) => {
            clock = d;
        },
    };
}

test("castNetworkBallot: a member's vote counts for the server it was clicked in and returns the scoreboard", async () => {
    const { deps, ballots } = createFakeDeps();
    const result = await castNetworkBallot("p1", "u1", "gB", FAKE, deps);
    expect(result).toEqual({ kind: "ok", scoreboard: { servers: { real: 0, fake: 1 }, people: { real: 0, fake: 1 } } });
    expect(ballots[0]).toMatchObject({ discord_user_id: "u1", guild_id: "gB" });
});

test("castNetworkBallot: the origin's members may vote, the finder may not", async () => {
    const { deps } = createFakeDeps();
    expect((await castNetworkBallot("p1", "u1", "gA", REAL, deps)).kind).toBe("ok");
    expect((await castNetworkBallot("p1", "finder", "gB", REAL, deps)).kind).toBe("finder");
});

test("castNetworkBallot: one vote per person across servers", async () => {
    const { deps, ballots } = createFakeDeps();
    await castNetworkBallot("p1", "u1", "gB", REAL, deps);
    expect((await castNetworkBallot("p1", "u1", "gC", FAKE, deps)).kind).toBe("already_voted");
    expect(ballots).toHaveLength(1);
});

test("castNetworkBallot: banned users, non-member servers and closed votes are refused", async () => {
    expect((await castNetworkBallot("p1", "bad", "gB", REAL, createFakeDeps(post(), { bannedUsers: ["bad"] }).deps)).kind).toBe("banned");
    expect((await castNetworkBallot("p1", "u1", "gX", REAL, createFakeDeps().deps)).kind).toBe("not_member");
    const late = createFakeDeps();
    late.setClock(new Date(T0.getTime() + 60_000));
    expect((await castNetworkBallot("p1", "u1", "gB", REAL, late.deps)).kind).toBe("closed");
    expect((await castNetworkBallot("nope", "u1", "gB", REAL, createFakeDeps().deps)).kind).toBe("not_found");
});

test("closeDueNetworkVotes: a Fake verdict edits every Mirror once, pings the origin's staff, DMs the owners and records the alert", async () => {
    const fake = createFakeDeps();
    await castNetworkBallot("p1", "u1", "gB", FAKE, fake.deps);
    await castNetworkBallot("p1", "u2", "gC", FAKE, fake.deps);
    fake.setClock(new Date(T0.getTime() + 60_000));
    await closeDueNetworkVotes(fake.deps);

    expect(fake.current().vote_status).toBe("fake");
    expect(fake.calls.edits.map((e) => e.mirror.message_id).sort()).toEqual(["m1", "m2"]);
    expect(JSON.stringify(fake.calls.edits[0].payload.components)).not.toContain("net-vote");
    expect(fake.calls.staff).toHaveLength(1);
    expect(fake.calls.staff[0].guildId).toBe("gA");
    expect(fake.calls.ownerDms).toHaveLength(1);
    expect(fake.calls.alerts[0]).toMatchObject({ kind: "fake_verdict", guildId: "gA", discordUserId: "finder", postId: "p1" });

    await closeDueNetworkVotes(fake.deps);
    expect(fake.calls.edits).toHaveLength(2);
});

test("closeNetworkVote: a Real or inconclusive result alerts no one", async () => {
    const fake = createFakeDeps();
    await castNetworkBallot("p1", "u1", "gB", REAL, fake.deps);
    expect(await closeNetworkVote("p1", "owner", fake.deps)).toBe("ok");
    expect(fake.current()).toMatchObject({ vote_status: "inconclusive", vote_closed_by: "owner" });
    expect(fake.calls.staff).toHaveLength(0);
    expect(fake.calls.ownerDms).toHaveLength(0);
});

test("closeNetworkVote: closing twice is already_closed and changes nothing", async () => {
    const fake = createFakeDeps();
    await closeNetworkVote("p1", "owner", fake.deps);
    expect(await closeNetworkVote("p1", "owner", fake.deps)).toBe("already_closed");
    expect(await closeNetworkVote("nope", "owner", fake.deps)).toBe("not_found");
});

test("castNetworkBallot: the first servers can vote while the post is still being sent to the rest", async () => {
    const { deps } = createFakeDeps(post({ status: "publishing", vote_closes_at: null }));
    expect((await castNetworkBallot("p1", "u1", "gB", REAL, deps)).kind).toBe("ok");
});

test("closeNetworkVote: the Fake verdict DM links the origin's name to its invite", async () => {
    const fake = createFakeDeps(post({ invite_url: "https://discord.gg/guilda" }));
    await castNetworkBallot("p1", "u1", "gB", FAKE, fake.deps);
    await castNetworkBallot("p1", "u2", "gC", FAKE, fake.deps);
    await closeNetworkVote("p1", null, fake.deps);
    expect(String(fake.calls.ownerDms[0].content)).toContain("[Guild A](https://discord.gg/guilda)");
});

test("closeNetworkVote: the closing edit keeps the biome's flavor text", async () => {
    const fake = createFakeDeps();
    await closeNetworkVote("p1", "owner", fake.deps);
    expect(JSON.stringify(fake.calls.edits[0].payload.components)).toContain("Unexpected error occurred. [Code 404]");
});
