import { expect, test } from "bun:test";
import { type MemberLogRow, type NetworkPostRow, type RareFind, VoteStatus } from "../types";
import { buildMemberQuality, qualityLevel } from "./member-quality.service";

const NOW = new Date("2026-10-25T00:00:00Z");

const find = (at: string, status: VoteStatus | null): RareFind => ({
    eventId: 1,
    biome: "GLITCHED",
    at: new Date(at),
    macroMessageId: null,
    macroChannelId: null,
    vote: status ? { id: "v", status, decidedBy: null, channelId: "c", messageId: "m", jumpLink: "j", real: 0, fake: 0 } : null,
});

const post = (at: string, vote_status: NetworkPostRow["vote_status"]) =>
    ({ id: at, vote_status, published_at: new Date(at), created_at: new Date(at) }) as NetworkPostRow;

test("qualityLevel: no level under 3 decided finds, then by fake rate and recent fakes", () => {
    expect(qualityLevel(2, 2, 2)).toBe("none");
    expect(qualityLevel(20, 1, 0)).toBe("trusted");
    expect(qualityLevel(20, 1, 1)).toBe("watch");
    expect(qualityLevel(10, 1, 0)).toBe("watch");
    expect(qualityLevel(10, 3, 0)).toBe("untrusted");
    expect(qualityLevel(40, 3, 3)).toBe("untrusted");
});

test("buildMemberQuality: tallies both places, counts only the fakes of the last 30 days as recent", () => {
    const finds = [
        find("2026-10-20T00:00:00Z", VoteStatus.COMMUNITY_REAL),
        find("2026-10-19T00:00:00Z", VoteStatus.ADMIN_CONFIRMED),
        find("2026-10-18T00:00:00Z", VoteStatus.TIE),
        find("2026-10-17T00:00:00Z", VoteStatus.OPEN),
        find("2026-10-16T00:00:00Z", VoteStatus.NO_VOTES),
        find("2026-10-15T00:00:00Z", null),
        ...Array.from({ length: 10 }, () => find("2026-09-01T00:00:00Z", VoteStatus.COMMUNITY_REAL)),
        find("2026-08-01T00:00:00Z", VoteStatus.ADMIN_DENIED),
    ];
    const q = buildMemberQuality(finds, [post("2026-10-10T00:00:00Z", "real"), post("2026-10-11T00:00:00Z", "inconclusive")], [], NOW);
    expect(q.local).toEqual({ real: 12, fake: 1, tied: 1, voting: 1 });
    expect(q.network).toEqual({ real: 1, fake: 0, tied: 1, voting: 0 });
    // 1 fake in 14 decided, and it's older than 30 days.
    expect(q.level).toBe("trusted");
    expect(q.history.map((e) => e.type)).toEqual(["local"]);
});

test("buildMemberQuality: history merges fakes and the admin log newest first, and sums the admin actions", () => {
    const log = [
        { kind: "sessions_deleted", detail: { count: 3 }, created_at: new Date("2026-10-22T00:00:00Z") },
        { kind: "finds_changed", detail: { biome: "GLITCHED", from: 4, to: 1 }, created_at: new Date("2026-10-12T00:00:00Z") },
        { kind: "finds_changed", detail: { biome: "GLITCHED", from: 1, to: 2 }, created_at: new Date("2026-10-11T00:00:00Z") },
        { kind: "badge_taken", detail: { badge: "GLITCHED" }, created_at: new Date("2026-10-10T00:00:00Z") },
    ] as MemberLogRow[];
    const q = buildMemberQuality(
        [find("2026-10-21T00:00:00Z", VoteStatus.COMMUNITY_FAKE)],
        [post("2026-10-23T00:00:00Z", "fake")],
        log,
        NOW,
    );
    expect(q.history.map((e) => e.type)).toEqual(["network", "log", "local", "log", "log", "log"]);
    expect(q.actions).toEqual({ sessionsDeleted: 3, badgesTaken: 1, findsRemoved: 3 });
    expect(q.level).toBe("none");
});
