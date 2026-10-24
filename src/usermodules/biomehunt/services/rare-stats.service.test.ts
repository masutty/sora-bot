import { expect, test } from "bun:test";
import { type GuildRareFind, type RareSession, VoteStatus } from "../types";
import { findsInPeriod, type RareStatsData, rareMembers, rareOverview, rarePace, rareQuality, rareRecords } from "./rare-stats.service";

const NOW = new Date("2026-10-23T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let nextId = 1;
const find = (biome: string, user: string, at: Date, status?: VoteStatus, ballots = { real: 0, fake: 0 }): GuildRareFind => ({
    eventId: nextId++,
    biome,
    at,
    macroMessageId: "m",
    macroChannelId: "c",
    vote: status
        ? { id: `v${nextId}`, status, decidedBy: null, channelId: "fc", messageId: "fm", jumpLink: "https://j", ...ballots }
        : null,
    userId: Number(user.replace(/\D/g, "")) || 1,
    discordUserId: user,
});

/** Newest first, like the repository returns them. */
const data = (finds: GuildRareFind[], sessions: RareSession[] = [], macro = { week: 0, month: 0, all: 0 }): RareStatsData => ({
    guildId: "g",
    finds: [...finds].sort((a, b) => b.at.getTime() - a.at.getTime()),
    sessions,
    macroSeconds: macro,
    now: NOW,
});

test("findsInPeriod keeps the period's finds only", () => {
    const d = data([
        find("GLITCHED", "u1", hoursAgo(1)),
        find("GLITCHED", "u1", hoursAgo(24 * 10)),
        find("GLITCHED", "u1", hoursAgo(24 * 40)),
    ]);
    expect(findsInPeriod(d, "week")).toHaveLength(1);
    expect(findsInPeriod(d, "month")).toHaveLength(2);
    expect(findsInPeriod(d, "all")).toHaveLength(3);
});

test("overview counts non-fake finds per biome in registry order, ranks finders and keeps fakes in Latest", () => {
    const d = data([
        find("DREAMSPACE", "u2", hoursAgo(1), VoteStatus.COMMUNITY_REAL),
        find("GLITCHED", "u1", hoursAgo(2)),
        find("GLITCHED", "u1", hoursAgo(3), VoteStatus.OPEN),
        find("GLITCHED", "u2", hoursAgo(4), VoteStatus.ADMIN_DENIED),
    ]);
    const o = rareOverview(d.finds);
    expect(o.biomes.map((b) => [b.biome, b.count])).toEqual([
        ["GLITCHED", 2],
        ["DREAMSPACE", 1],
    ]);
    expect(o.biomes[0].last).toEqual(hoursAgo(2));
    expect(o.fake).toBe(1);
    expect(o.top).toEqual([
        { discordUserId: "u1", count: 2, emojis: "🔥2" },
        { discordUserId: "u2", count: 1, emojis: "🌸1" },
    ]);
    expect(o.latest).toHaveLength(4);
});

test("quality: real % from decided finds only, vote breakdown, average ballots and no-forward finds", () => {
    const d = data([
        find("GLITCHED", "u1", hoursAgo(1), VoteStatus.COMMUNITY_REAL, { real: 4, fake: 1 }),
        find("GLITCHED", "u1", hoursAgo(2), VoteStatus.ADMIN_DENIED, { real: 1, fake: 2 }),
        find("GLITCHED", "u1", hoursAgo(3), VoteStatus.TIE, { real: 1, fake: 1 }),
        find("DREAMSPACE", "u1", hoursAgo(4)),
    ]);
    const q = rareQuality(d.finds);
    expect([q.real, q.fake]).toEqual([1, 1]);
    expect(q.biomes).toEqual([{ biome: "GLITCHED", real: 1, fake: 1 }]);
    expect(q.votes[VoteStatus.TIE]).toBe(1);
    expect(q.votes[VoteStatus.COMMUNITY_REAL]).toBe(1);
    expect(q.avgBallots).toBe(10 / 3);
    expect(q.noVote).toBe(1);
    expect(rareQuality([]).avgBallots).toBeNull();
});

test("members: flag from 3 decided finds under 50% real, flagged first then most fakes", () => {
    const d = data([
        find("GLITCHED", "u1", hoursAgo(1), VoteStatus.COMMUNITY_REAL),
        find("GLITCHED", "u2", hoursAgo(2), VoteStatus.COMMUNITY_FAKE),
        find("GLITCHED", "u2", hoursAgo(3), VoteStatus.ADMIN_DENIED),
        find("GLITCHED", "u2", hoursAgo(4), VoteStatus.COMMUNITY_REAL),
        find("GLITCHED", "u3", hoursAgo(5), VoteStatus.COMMUNITY_FAKE),
        find("GLITCHED", "u4", hoursAgo(6), VoteStatus.OPEN),
    ]);
    const m = rareMembers(d.finds);
    expect(m.map((x) => [x.discordUserId, x.real, x.fake, x.flagged])).toEqual([
        ["u2", 1, 2, true],
        ["u3", 0, 1, false],
        ["u1", 1, 0, false],
    ]);
    expect(m[0].lastFake).toEqual(hoursAgo(2));
});

test("pace: macro time per find, 14 daily buckets, week vs last week, and overdue biomes", () => {
    const d = data(
        [
            find("GLITCHED", "u1", hoursAgo(1)),
            find("GLITCHED", "u1", hoursAgo(2)),
            find("GLITCHED", "u1", hoursAgo(24 * 8)),
            find("GLITCHED", "u1", hoursAgo(3), VoteStatus.COMMUNITY_FAKE),
            find("DREAMSPACE", "u1", hoursAgo(24 * 30)),
            find("DREAMSPACE", "u1", hoursAgo(24 * 25)),
            find("DREAMSPACE", "u1", hoursAgo(24 * 20)),
        ],
        [],
        { week: 20 * 3600, month: 100 * 3600, all: 200 * 3600 },
    );
    const week = rarePace(d, "week");
    expect(week.count).toBe(2);
    expect(week.everySeconds).toBe(10 * 3600);
    expect(week.biomes).toEqual([{ biome: "GLITCHED", count: 2, everySeconds: 10 * 3600 }]);
    expect(week.days).toHaveLength(14);
    expect(week.days[13]).toBe(2);
    expect(week.days.reduce((a, b) => a + b, 0)).toBe(3);
    expect([week.thisWeek, week.lastWeek]).toEqual([2, 1]);
    // Dreamspace: usually every 5 days, none for 20 - overdue. Glitched found an hour ago - not.
    expect(week.waiting.map((w) => w.biome)).toEqual(["DREAMSPACE"]);
    expect(rarePace(data([]), "all").everySeconds).toBeNull();
});

test("records: session, day, fastest, back to back, longest wait and first - fakes left out", () => {
    const session: RareSession = { id: 42, userId: 1, startedAt: hoursAgo(10), endedAt: hoursAgo(5) };
    const d = data(
        [
            find("GLITCHED", "u1", hoursAgo(9)),
            find("GLITCHED", "u1", hoursAgo(8.5)),
            find("DREAMSPACE", "u1", hoursAgo(7)),
            find("GLITCHED", "u1", hoursAgo(9.9), VoteStatus.ADMIN_DENIED),
            find("DREAMSPACE", "u2", hoursAgo(24 * 5)),
        ],
        [session],
    );
    const r = rareRecords(d.finds, d.sessions);
    expect(r.mostInSession).toEqual({ discordUserId: "u1", sessionId: 42, count: 3, emojis: "🔥2 🌸1" });
    expect(r.bestDay?.count).toBe(3);
    expect(r.fastest).toEqual({ discordUserId: "u1", biome: "GLITCHED", seconds: 3600 });
    expect(r.backToBack).toEqual({ discordUserId: "u1", biome: "GLITCHED", seconds: 1800 });
    expect(r.longestWait?.biome).toBe("DREAMSPACE");
    expect(r.first?.discordUserId).toBe("u2");
    expect(rareRecords([], [])).toEqual({
        mostInSession: null,
        bestDay: null,
        fastest: null,
        backToBack: null,
        longestWait: null,
        first: null,
    });
});
