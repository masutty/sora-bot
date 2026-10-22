import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import type { BadgeRow, FanoutRow } from "../types";
import { type PollerDeps, runRound, type SendResult } from "./poller.service";
import type { PostStatus } from "./post-status";
import type { BadgeFetchResult } from "./roblox.client";

const NOW = new Date("2026-10-22T12:00:00Z");

function badge(id: string, over: Partial<BadgeRow> = {}): BadgeRow {
    return {
        badge_id: id,
        name: `Badge ${id}`,
        description: `Desc ${id}`,
        icon_url: `https://img.test/icon-${id}.png`,
        awarded_count: "100",
        last_checked_at: new Date(NOW.getTime() - 300_000),
        meta_refreshed_at: new Date(NOW.getTime() - 1000),
        not_found_streak: 0,
        deleted: false,
        ...over,
    };
}

function sub(guild: string, badgeId: string, over: Partial<FanoutRow> = {}): FanoutRow {
    return {
        guild_id: guild,
        badge_id: badgeId,
        ping_role_id: null,
        custom_description: null,
        accent_color: null,
        channel_id: `ch-${guild}`,
        ...over,
    };
}

interface Setup {
    rows: FanoutRow[];
    badges?: BadgeRow[];
    fetches?: Record<string, BadgeFetchResult>;
    statuses?: Record<string, PostStatus>;
    roles?: Set<string>;
    sendResult?: (channelId: string) => SendResult;
    intervalMs?: number;
}

function make(setup: Setup) {
    const badges = new Map((setup.badges ?? []).map((b) => [b.badge_id, b]));
    for (const r of setup.rows) if (!badges.has(r.badge_id)) badges.set(r.badge_id, badge(r.badge_id));
    const log = {
        fetched: [] as string[],
        sleeps: [] as number[],
        sent: [] as { channelId: string; payload: MessageCreateOptions }[],
        checks: [] as [string, number][],
        metas: [] as unknown[][],
        baselines: [] as string[][],
        iconCalls: [] as string[][],
        channelsCleared: [] as string[],
        clearCalls: [] as [string, string][],
        deleted: [] as string[],
    };
    const deps: PollerDeps = {
        roblox: {
            async fetchBadge(id) {
                log.fetched.push(id);
                const b = badges.get(id) as BadgeRow;
                return (
                    setup.fetches?.[id] ?? {
                        kind: "ok",
                        badge: { id, name: b.name, description: b.description, awardedCount: Number(b.awarded_count) },
                    }
                );
            },
            async fetchIcons(ids) {
                log.iconCalls.push(ids);
                return new Map(ids.map((i) => [i, `https://img.test/new-${i}.png`]));
            },
        },
        now: () => NOW,
        sleep: async (ms) => {
            log.sleeps.push(ms);
        },
        intervalMs: setup.intervalMs ?? 300_000,
        postStatus: (g) => setup.statuses?.[g] ?? "ok",
        roleExists: (_g, r) => setup.roles?.has(r) ?? true,
        send: async (channelId, payload) => {
            log.sent.push({ channelId, payload });
            return setup.sendResult?.(channelId) ?? "sent";
        },
        repo: {
            getAllFanoutRows: async () => setup.rows,
            getFanoutRowsForBadge: async (id) => setup.rows.filter((r) => r.badge_id === id),
            getBadges: async (ids) => ids.map((i) => badges.get(i)).filter((b): b is BadgeRow => !!b),
            recordCheck: async (id, count) => {
                log.checks.push([id, count]);
            },
            updateBadgeMeta: async (...args) => {
                log.metas.push(args);
            },
            clearBaselines: async (ids) => {
                log.baselines.push(ids);
            },
            incrementNotFound: async (id) => {
                const b = badges.get(id) as BadgeRow;
                b.not_found_streak += 1;
                return b.not_found_streak;
            },
            markDeleted: async (id) => {
                log.deleted.push(id);
            },
            clearTrackerChannelIf: async (g, ch) => {
                log.channelsCleared.push(g);
                log.clearCalls.push([g, ch]);
            },
        },
    };
    return { deps, log };
}

const ok = (id: string, count: number): BadgeFetchResult => ({
    kind: "ok",
    badge: { id, name: `Badge ${id}`, description: `Desc ${id}`, awardedCount: count },
});

const text = (p: MessageCreateOptions) => JSON.stringify(p);

const twoGuilds = [sub("A", "1"), sub("A", "2"), sub("A", "3"), sub("B", "2"), sub("B", "3"), sub("B", "4")];

describe("runRound", () => {
    test("polls each live badge once even when several servers track it", async () => {
        const { deps, log } = make({ rows: twoGuilds });
        const result = await runRound(deps);
        expect(log.fetched.sort()).toEqual(["1", "2", "3", "4"]);
        expect(result).toEqual({ kind: "done", checked: 4 });
    });

    test("skips badges whose only subscriber cannot receive posts", async () => {
        const { deps, log } = make({ rows: twoGuilds, statuses: { A: "no_permission" } });
        await runRound(deps);
        expect(log.fetched).toEqual(["2", "3", "4"]);
    });

    test("clears baselines of badges with no live subscription", async () => {
        const { deps, log } = make({ rows: twoGuilds, statuses: { A: "no_permission" } });
        await runRound(deps);
        expect(log.baselines).toEqual([["2", "3", "4"]]);
    });

    test("clears a missing channel and still posts to other servers", async () => {
        const { deps, log } = make({
            rows: twoGuilds,
            statuses: { A: "channel_missing" },
            fetches: { "2": ok("2", 105) },
        });
        await runRound(deps);
        expect(log.channelsCleared).toEqual(["A"]);
        expect(log.clearCalls).toEqual([["A", "ch-A"]]);
        expect(log.sent.map((s) => s.channelId)).toEqual(["ch-B"]);
    });

    test("spaces requests over 80% of the interval", async () => {
        const { deps, log } = make({ rows: twoGuilds });
        await runRound(deps);
        expect(log.sleeps).toEqual([60000, 60000, 60000]);

        const many = Array.from({ length: 2000 }, (_, i) => sub("A", String(i + 1)));
        const big = make({ rows: many });
        await runRound(big.deps);
        expect(big.log.sleeps.length).toBe(1999);
        expect(big.log.sleeps.every((ms) => ms >= 250)).toBe(true);
    });

    test("posts once per subscription on a positive delta, with its own role and description", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1", { ping_role_id: "roleA", custom_description: "Custom A" }), sub("B", "1")],
            fetches: { "1": ok("1", 110) },
        });
        await runRound(deps);
        expect(log.sent.map((s) => s.channelId).sort()).toEqual(["ch-A", "ch-B"]);
        const a = log.sent.find((s) => s.channelId === "ch-A") as { payload: MessageCreateOptions };
        const b = log.sent.find((s) => s.channelId === "ch-B") as { payload: MessageCreateOptions };
        expect(text(a.payload)).toContain("Custom A");
        expect(text(a.payload)).toContain("roleA");
        expect(text(b.payload)).toContain("Desc 1");
        expect(text(b.payload)).not.toContain("roleA");
    });

    test("posts nothing for unchanged, decreased or baseline outcomes, but always records the check", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2"), sub("A", "3")],
            badges: [badge("3", { awarded_count: null })],
            fetches: { "1": ok("1", 100), "2": ok("2", 90), "3": ok("3", 50) },
        });
        await runRound(deps);
        expect(log.sent).toEqual([]);
        expect(log.checks).toEqual([
            ["1", 100],
            ["2", 90],
            ["3", 50],
        ]);
    });

    test("drops the ping when the role no longer exists", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1", { ping_role_id: "gone" })],
            fetches: { "1": ok("1", 110) },
            roles: new Set(),
        });
        await runRound(deps);
        const payload = log.sent[0]?.payload as MessageCreateOptions;
        expect(text(payload)).not.toContain("gone");
        expect(payload.allowedMentions).toEqual({ parse: [], roles: [] });
    });

    test("stops the round and reports rate_limited on a 429", async () => {
        const { deps, log } = make({
            rows: twoGuilds,
            fetches: { "2": { kind: "rate_limited", retryAfterMs: 5000 } },
        });
        const result = await runRound(deps);
        expect(result).toEqual({ kind: "rate_limited", retryAfterMs: 5000 });
        expect(log.fetched).toEqual(["1", "2"]);
    });

    test("marks a badge deleted only on the second consecutive not_found, and posts the deleted card once per live subscription", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("B", "1")],
            fetches: { "1": { kind: "not_found" } },
        });
        await runRound(deps);
        expect(log.deleted).toEqual([]);
        expect(log.sent).toEqual([]);
        await runRound(deps);
        expect(log.deleted).toEqual(["1"]);
        expect(log.sent.map((s) => s.channelId).sort()).toEqual(["ch-A", "ch-B"]);
        expect(text(log.sent[0]?.payload as MessageCreateOptions)).toContain("deleted");
    });

    test("refreshes name, description and icon when meta is older than 24h", async () => {
        const stale = new Date(NOW.getTime() - 90_000_000);
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2")],
            badges: [badge("1", { meta_refreshed_at: stale })],
        });
        await runRound(deps);
        expect(log.iconCalls).toEqual([["1"]]);
        expect(log.metas).toEqual([["1", "Badge 1", "Desc 1", "https://img.test/new-1.png", NOW]]);
    });

    test("skips deleted badges", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2")],
            badges: [badge("1", { deleted: true })],
        });
        await runRound(deps);
        expect(log.fetched).toEqual(["2"]);
        expect(log.baselines).toEqual([["2"]]);
    });

    test("clears the channel on unknown_channel from send", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2")],
            fetches: { "1": ok("1", 110), "2": ok("2", 110) },
            sendResult: () => "unknown_channel",
        });
        await runRound(deps);
        expect(log.channelsCleared).toEqual(["A"]);
        expect(log.sent.length).toBe(1);
    });

    test("unknown_channel clears only the channel id from the snapshot", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1")],
            fetches: { "1": ok("1", 110) },
            sendResult: () => "unknown_channel",
        });
        await runRound(deps);
        expect(log.clearCalls).toEqual([["A", "ch-A"]]);
    });

    test("forbidden stops further sends to that guild this round", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2"), sub("B", "1"), sub("B", "2")],
            fetches: { "1": ok("1", 110), "2": ok("2", 110) },
            sendResult: (ch) => (ch === "ch-A" ? "forbidden" : "sent"),
        });
        await runRound(deps);
        expect(log.sent.map((s) => s.channelId).sort()).toEqual(["ch-A", "ch-B", "ch-B"]);
    });

    test("a failed send is logged and other guilds are still served", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("B", "1")],
            fetches: { "1": ok("1", 110) },
            sendResult: (ch) => (ch === "ch-A" ? "failed" : "sent"),
        });
        const result = await runRound(deps);
        expect(result).toEqual({ kind: "done", checked: 1 });
        expect(log.sent.map((s) => s.channelId).sort()).toEqual(["ch-A", "ch-B"]);
    });

    test("skips a send when the guild status flips to no_permission mid-round", async () => {
        const statuses: Record<string, PostStatus> = {};
        const { deps, log } = make({ rows: [sub("A", "1")], fetches: { "1": ok("1", 110) }, statuses });
        const fetchBadge = deps.roblox.fetchBadge;
        deps.roblox.fetchBadge = async (id) => {
            statuses.A = "no_permission";
            return fetchBadge(id);
        };
        await runRound(deps);
        expect(log.sent).toEqual([]);
    });

    test("a subscription removed mid-round gets no post", async () => {
        const rows = [sub("A", "1"), sub("B", "1")];
        const { deps, log } = make({ rows, fetches: { "1": ok("1", 110) } });
        const fetchBadge = deps.roblox.fetchBadge;
        deps.roblox.fetchBadge = async (id) => {
            rows.splice(0, 1);
            return fetchBadge(id);
        };
        await runRound(deps);
        expect(log.sent.map((s) => s.channelId)).toEqual(["ch-B"]);
    });

    test("a ping role cleared mid-round is not pinged", async () => {
        const rows = [sub("A", "1", { ping_role_id: "roleA" })];
        const { deps, log } = make({ rows, fetches: { "1": ok("1", 110) } });
        const fetchBadge = deps.roblox.fetchBadge;
        deps.roblox.fetchBadge = async (id) => {
            rows[0] = sub("A", "1");
            return fetchBadge(id);
        };
        await runRound(deps);
        expect(text(log.sent[0]?.payload as MessageCreateOptions)).not.toContain("roleA");
    });

    test("fetches the least recently checked badges first", async () => {
        const { deps, log } = make({
            rows: [sub("A", "1"), sub("A", "2"), sub("A", "3")],
            badges: [
                badge("1", { last_checked_at: new Date(NOW.getTime() - 1000) }),
                badge("2", { last_checked_at: null }),
                badge("3", { last_checked_at: new Date(NOW.getTime() - 900_000) }),
            ],
        });
        await runRound(deps);
        expect(log.fetched).toEqual(["2", "3", "1"]);
    });
});
