import { expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import type { InsertNetworkAlertParams } from "../repository/network-posts.repository";
import {
    type BiomeDelayedForwardRow,
    type NetworkBanKind,
    type NetworkGuildRow,
    type NetworkMirrorRow,
    type NetworkPostRow,
    NetworkStatus,
} from "../types";
import type { EligibilityFacts, EligibilityGap } from "./network-eligibility.service";
import {
    type NetworkPublishDeps,
    parseRelayGuildIds,
    publishDuePosts,
    type ScheduleInput,
    scheduleNetworkPost,
    scheduleSimulatedNetworkPost,
} from "./network-publish.service";

const LINK = "https://www.roblox.com/share?code=CODE1&type=Server";
const T0 = new Date("2026-10-02T12:00:00Z");

function guildRow(guildId: string, overrides: Partial<NetworkGuildRow> = {}): NetworkGuildRow {
    return {
        guild_id: guildId,
        status: NetworkStatus.MEMBER,
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
        ...overrides,
    };
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
    return {
        originGuildId: "gA",
        originName: "Guild A",
        originIconUrl: null,
        finderDiscordId: "u1",
        eventId: 7,
        biome: "GLITCHED",
        serverLink: LINK,
        now: T0,
        ...overrides,
    };
}

interface FakeOptions {
    guilds?: NetworkGuildRow[];
    posts?: NetworkPostRow[];
    banned?: Array<[NetworkBanKind, string]>;
    excluded?: string[];
    gaps?: EligibilityGap[];
    delayS?: number | null;
    priorMultiMacro?: boolean;
    failingChannels?: string[];
}

function createFakeDeps(opts: FakeOptions = {}) {
    const guilds = new Map((opts.guilds ?? [guildRow("gA"), guildRow("gB"), guildRow("gC")]).map((g) => [g.guild_id, g]));
    const posts = new Map((opts.posts ?? []).map((p) => [p.id, p]));
    const bans = new Set((opts.banned ?? []).map(([k, id]) => `${k}:${id}`));
    let clock = T0;
    let ids = 0;
    const calls = {
        alerts: [] as InsertNetworkAlertParams[],
        ownerDms: [] as MessageCreateOptions[],
        sent: [] as Array<{ channelId: string; payload: MessageCreateOptions }>,
        mirrors: [] as NetworkMirrorRow[],
    };
    const deps: NetworkPublishDeps = {
        getNetworkGuild: async (id) => guilds.get(id) ?? null,
        isNetworkBanned: async (kind, id) => bans.has(`${kind}:${id}`),
        isNetworkExcluded: async (_g, userId) => (opts.excluded ?? []).includes(userId),
        loadEligibility: async () => ({
            facts: {} as EligibilityFacts,
            gaps: opts.gaps ?? [],
            card: { activeMembers: 3, macroHours7d: 1, macroHours30d: 1 },
        }),
        getDelayedForwardConfig: async () =>
            opts.delayS === undefined || opts.delayS === null
                ? null
                : ({ channel_id: "local-d", delay_s: opts.delayS } as BiomeDelayedForwardRow),
        getRecentNetworkPosts: async (biome, since) => [...posts.values()].filter((p) => p.biome === biome && p.created_at >= since),
        insertNetworkPost: async (p) => {
            const row: NetworkPostRow = {
                id: p.id,
                origin_guild_id: p.originGuildId,
                origin_name: p.originName,
                origin_icon_url: p.originIconUrl,
                invite_url: p.inviteUrl,
                event_id: p.eventId,
                finder_discord_id: p.finderDiscordId,
                biome: p.biome,
                server_link: p.serverLink,
                server_code: p.serverCode,
                simulated: p.simulated ?? false,
                relay_guild_ids: p.relayGuildIds ?? null,
                status: "pending",
                publish_at: p.publishAt,
                published_at: null,
                vote_status: p.simulated ? "inconclusive" : "open",
                vote_closes_at: null,
                vote_closed_by: null,
                created_at: clock,
            };
            posts.set(row.id, row);
            return row;
        },
        hasNetworkAlert: async () => opts.priorMultiMacro ?? false,
        insertNetworkAlert: async (a) => {
            calls.alerts.push(a);
        },
        notifyOwners: async (payload) => {
            calls.ownerDms.push(payload);
        },
        newPostId: () => `p${++ids}`,
        getDuePendingPosts: async (now) => [...posts.values()].filter((p) => p.status === "pending" && p.publish_at <= now),
        getStalePublishingPosts: async (before) => [...posts.values()].filter((p) => p.status === "publishing" && p.publish_at < before),
        claimNetworkPost: async (id) => {
            const p = posts.get(id);
            if (!p || p.status !== "pending") return false;
            posts.set(id, { ...p, status: "publishing" });
            return true;
        },
        markNetworkPostPublished: async (id, publishedAt, closesAt) => {
            const p = posts.get(id);
            if (p) posts.set(id, { ...p, status: "published", published_at: publishedAt, vote_closes_at: closesAt });
        },
        markNetworkPostDiscarded: async (id) => {
            const p = posts.get(id);
            if (p) posts.set(id, { ...p, status: "discarded" });
        },
        getMemberNetworkGuilds: async () => [...guilds.values()].filter((g) => g.status === NetworkStatus.MEMBER),
        getNetworkPingRolesForBiome: async () => new Map([["gB", "ping-B"]]),
        insertNetworkMirror: async (m) => {
            calls.mirrors.push(m);
        },
        sendMirror: async (channelId, payload) => {
            if ((opts.failingChannels ?? []).includes(channelId)) return null;
            calls.sent.push({ channelId, payload });
            return { channelId, messageId: `m-${channelId}` };
        },
        shuffle: (items) => [...items].reverse(),
        now: () => clock,
    };
    return {
        deps,
        posts,
        calls,
        setClock: (d: Date) => {
            clock = d;
        },
    };
}

test("scheduleNetworkPost: a member's find is scheduled at the local post + the home advantage", async () => {
    const { deps, posts } = createFakeDeps();
    expect(await scheduleNetworkPost(input(), deps)).toEqual({ kind: "scheduled", postId: "p1" });
    expect(posts.get("p1")?.publish_at).toEqual(new Date(T0.getTime() + 10_000));
    expect(posts.get("p1")?.server_code).toBe("CODE1");
});

test("scheduleNetworkPost: with only a delayed local forward, the home advantage starts after it", async () => {
    const { deps, posts } = createFakeDeps({ delayS: 15 });
    await scheduleNetworkPost(input({ biome: "SINGULARITY" }), deps);
    expect(posts.get("p1")?.publish_at).toEqual(new Date(T0.getTime() + (15 + 30) * 1000));
});

test("scheduleNetworkPost: skips non-Network biomes, missing private server links and non-members", async () => {
    expect((await scheduleNetworkPost(input({ biome: "STARFALL" }), createFakeDeps().deps)).kind).toBe("skipped");
    expect((await scheduleNetworkPost(input({ serverLink: "https://www.roblox.com/games/1/x" }), createFakeDeps().deps)).kind).toBe(
        "skipped",
    );
    const pending = createFakeDeps({ guilds: [guildRow("gA", { status: NetworkStatus.PENDING })] });
    expect((await scheduleNetworkPost(input(), pending.deps)).kind).toBe("skipped");
});

test("scheduleNetworkPost: banned guild, banned user and excluded member are not published", async () => {
    expect((await scheduleNetworkPost(input(), createFakeDeps({ banned: [["guild", "gA"]] }).deps)).kind).toBe("skipped");
    expect((await scheduleNetworkPost(input(), createFakeDeps({ banned: [["user", "u1"]] }).deps)).kind).toBe("skipped");
    expect((await scheduleNetworkPost(input(), createFakeDeps({ excluded: ["u1"] }).deps)).kind).toBe("skipped");
});

test("scheduleNetworkPost: a forced member publishes only when it passes the checklist", async () => {
    const forced = [guildRow("gA", { forced: true })];
    expect((await scheduleNetworkPost(input(), createFakeDeps({ guilds: forced, gaps: [{ kind: "staff" }] }).deps)).kind).toBe("skipped");
    expect((await scheduleNetworkPost(input(), createFakeDeps({ guilds: forced }).deps)).kind).toBe("scheduled");
});

test("scheduleNetworkPost: the same private server within the window is a duplicate with no alert", async () => {
    const { deps, calls } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    expect(await scheduleNetworkPost(input({ originGuildId: "gB", finderDiscordId: "u2" }), deps)).toEqual({ kind: "duplicate" });
    expect(calls.alerts).toHaveLength(0);
});

test("scheduleNetworkPost: same user and biome from another server is Multi Macro - first one DMs the owners", async () => {
    const { deps, calls } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    const other = input({ originGuildId: "gB", serverLink: "https://www.roblox.com/share?code=CODE2&type=Server" });
    expect(await scheduleNetworkPost(other, deps)).toEqual({ kind: "multi_macro" });
    expect(calls.alerts).toHaveLength(1);
    expect(calls.alerts[0]).toMatchObject({ kind: "multi_macro", discordUserId: "u1", guildId: "gB", notified: true });
    expect(calls.ownerDms).toHaveLength(1);
});

test("scheduleNetworkPost: a later Multi Macro of the same user waits for the digest", async () => {
    const { deps, calls } = createFakeDeps({ priorMultiMacro: true });
    await scheduleNetworkPost(input(), deps);
    await scheduleNetworkPost(input({ originGuildId: "gB", serverLink: "https://www.roblox.com/share?code=CODE2&type=Server" }), deps);
    expect(calls.alerts[0]?.notified).toBe(false);
    expect(calls.ownerDms).toHaveLength(0);
});

test("scheduleNetworkPost: outside the window the same user is a new find", async () => {
    const { deps, setClock } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    const later = new Date(T0.getTime() + 3 * 60_000);
    setClock(later);
    const other = input({ originGuildId: "gB", now: later, serverLink: "https://www.roblox.com/share?code=CODE2&type=Server" });
    expect((await scheduleNetworkPost(other, deps)).kind).toBe("scheduled");
});

test("publishDuePosts: sends a Mirror to every other member (not the origin), with each server's ping, and opens the vote", async () => {
    const { deps, posts, calls, setClock } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    setClock(new Date(T0.getTime() + 11_000));
    await publishDuePosts(deps);

    expect(calls.sent.map((s) => s.channelId)).toEqual(["net-gC", "net-gB"]);
    expect(calls.sent[1].payload.allowedMentions).toEqual({ parse: [], roles: ["ping-B"] });
    expect(calls.mirrors.map((m) => m.guild_id).sort()).toEqual(["gB", "gC"]);
    const post = posts.get("p1");
    expect(post?.status).toBe("published");
    expect(post?.vote_closes_at).toEqual(new Date(T0.getTime() + 11_000 + 60_000));
});

test("publishDuePosts: a destination that fails is skipped and the others still get it", async () => {
    const { deps, calls, setClock } = createFakeDeps({ failingChannels: ["net-gC"] });
    await scheduleNetworkPost(input(), deps);
    setClock(new Date(T0.getTime() + 11_000));
    await publishDuePosts(deps);
    expect(calls.mirrors.map((m) => m.guild_id)).toEqual(["gB"]);
});

test("publishDuePosts: a post more than 2 minutes late is discarded, not sent", async () => {
    const { deps, posts, calls, setClock } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    setClock(new Date(T0.getTime() + 10_000 + 2 * 60_000 + 1));
    await publishDuePosts(deps);
    expect(posts.get("p1")?.status).toBe("discarded");
    expect(calls.sent).toHaveLength(0);
});

test("publishDuePosts: the rules are checked again at send - a user banned meanwhile is discarded", async () => {
    const fake = createFakeDeps();
    await scheduleNetworkPost(input(), fake.deps);
    fake.deps.isNetworkBanned = async (kind, id) => kind === "user" && id === "u1";
    fake.setClock(new Date(T0.getTime() + 11_000));
    await publishDuePosts(fake.deps);
    expect(fake.posts.get("p1")?.status).toBe("discarded");
    expect(fake.calls.sent).toHaveLength(0);
});

test("scheduleNetworkPost: the stored link is rebuilt from the validated code, not the macro's text", async () => {
    const { deps, posts } = createFakeDeps();
    await scheduleNetworkPost(input({ serverLink: "https://www.roblox.com/share?code=CODE1&type=Server&utm=*x*" }), deps);
    expect(posts.get("p1")?.server_link).toBe("https://www.roblox.com/share?code=CODE1&type=Server");
});

test("scheduleNetworkPost: one macro posting the same private server to two servers is Multi Macro, not a quiet duplicate", async () => {
    const { deps, calls } = createFakeDeps();
    await scheduleNetworkPost(input(), deps);
    expect(await scheduleNetworkPost(input({ originGuildId: "gB" }), deps)).toEqual({ kind: "multi_macro" });
    expect(calls.alerts).toHaveLength(1);
});

test("scheduleNetworkPost: two webhooks of the same macro arriving at once still publish only one post", async () => {
    const { deps, posts } = createFakeDeps();
    const results = await Promise.all([scheduleNetworkPost(input(), deps), scheduleNetworkPost(input({ originGuildId: "gB" }), deps)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["multi_macro", "scheduled"]);
    expect(posts.size).toBe(1);
});

test("publishDuePosts: a post left in 'publishing' by a crash is finalized so its vote can close", async () => {
    const stuck = {
        id: "s1",
        origin_guild_id: "gA",
        origin_name: "Guild A",
        origin_icon_url: null,
        invite_url: null,
        event_id: 1,
        finder_discord_id: "u1",
        biome: "GLITCHED",
        server_link: LINK,
        server_code: "CODE1",
        simulated: false,
        relay_guild_ids: null,
        status: "publishing" as const,
        publish_at: new Date(T0.getTime() - 3 * 60_000),
        published_at: null,
        vote_status: "open" as const,
        vote_closes_at: null,
        vote_closed_by: null,
        created_at: new Date(T0.getTime() - 3 * 60_000),
    };
    const { deps, posts } = createFakeDeps({ posts: [stuck] });
    await publishDuePosts(deps);
    expect(posts.get("s1")).toMatchObject({ status: "published", vote_closes_at: new Date(T0.getTime() + 60_000) });
});

test("parseRelayGuildIds: comma or space separated Discord ids, duplicates dropped, anything else refused", () => {
    expect(parseRelayGuildIds("111111111111111111, 222222222222222222 111111111111111111")).toEqual([
        "111111111111111111",
        "222222222222222222",
    ]);
    expect(() => parseRelayGuildIds("111111111111111111,abc")).toThrow();
    expect(() => parseRelayGuildIds("  ")).toThrow();
});

test("scheduleSimulatedNetworkPost: only a Network biome from a Member Server can be relayed", async () => {
    expect((await scheduleSimulatedNetworkPost(input({ biome: "STARFALL" }), ["gB"], createFakeDeps().deps)).kind).toBe("skipped");
    const outside = createFakeDeps({ guilds: [guildRow("gA", { status: NetworkStatus.NONE }), guildRow("gB")] });
    expect((await scheduleSimulatedNetworkPost(input(), ["gB"], outside.deps)).kind).toBe("skipped");
});

test("scheduleSimulatedNetworkPost: keeps only relay servers that can receive Network posts, never the origin", async () => {
    const guilds = [
        guildRow("gA"),
        guildRow("gB"),
        guildRow("gC", { status: NetworkStatus.PENDING }),
        guildRow("gD", { network_channel_id: null }),
    ];
    const { deps, posts } = createFakeDeps({ guilds });
    const result = await scheduleSimulatedNetworkPost(input(), ["gA", "gB", "gC", "gD", "gX"], deps);
    expect(result).toEqual({ kind: "scheduled", postId: "p1", targets: ["gB"], ignored: ["gA", "gC", "gD", "gX"] });
    expect(posts.get("p1")?.relay_guild_ids).toEqual(["gB"]);
});

test("scheduleSimulatedNetworkPost: no usable relay server means nothing is scheduled", async () => {
    const { deps, posts } = createFakeDeps();
    expect((await scheduleSimulatedNetworkPost(input(), ["gA", "gX"], deps)).kind).toBe("skipped");
    expect(posts.size).toBe(0);
});

test("scheduleSimulatedNetworkPost: skips dedup, uses its own test server code and opens no vote", async () => {
    const { deps, posts, calls } = createFakeDeps();
    await scheduleNetworkPost(input({ originGuildId: "gB" }), deps);
    const result = await scheduleSimulatedNetworkPost(input({ serverLink: null }), ["gC"], deps);
    expect(result.kind).toBe("scheduled");
    expect(posts.get("p2")).toMatchObject({ simulated: true, vote_status: "inconclusive" });
    expect(posts.get("p2")?.server_code).toStartWith("SIM-");
    expect(posts.get("p2")?.publish_at).toEqual(new Date(T0.getTime() + 10_000));
    expect(calls.alerts).toHaveLength(0);
});

test("publishDuePosts: a simulated relay reaches only its relay servers, marked as a test, with no ping and no vote", async () => {
    const { deps, calls, setClock } = createFakeDeps();
    await scheduleSimulatedNetworkPost(input(), ["gB"], deps);
    setClock(new Date(T0.getTime() + 11_000));
    await publishDuePosts(deps);

    expect(calls.sent.map((x) => x.channelId)).toEqual(["net-gB"]);
    const { payload } = calls.sent[0];
    expect(payload.allowedMentions).toEqual({ parse: [], roles: [] });
    const body = JSON.stringify(payload.components);
    expect(body).toContain("SIMULATED");
    expect(body).not.toContain("net-vote");
});

test("scheduleNetworkPost: the Multi Macro DM links both servers' names to their invites", async () => {
    const guilds = [guildRow("gA", { invite_url: "https://discord.gg/a" }), guildRow("gB", { invite_url: "https://discord.gg/b" })];
    const { deps, calls } = createFakeDeps({ guilds });
    await scheduleNetworkPost(input(), deps);
    await scheduleNetworkPost(input({ originGuildId: "gB", originName: "Guild B" }), deps);
    const dm = String(calls.ownerDms[0].content);
    expect(dm).toContain("[Guild A](https://discord.gg/a)");
    expect(dm).toContain("[Guild B](https://discord.gg/b)");
});

test("scheduleNetworkPost: with both a live and a delayed local forward, the Network still waits for the delayed one", async () => {
    const { deps, posts } = createFakeDeps({ delayS: 45 });
    await scheduleNetworkPost(input(), deps);
    expect(posts.get("p1")?.publish_at).toEqual(new Date(T0.getTime() + (45 + 10) * 1000));
});
