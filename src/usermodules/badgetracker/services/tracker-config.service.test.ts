import { describe, expect, test } from "bun:test";
import { type BadgeRow, BadgeTrackerError, type GuildBadgeRow, type RobloxBadge } from "../types";
import type { BadgeFetchResult } from "./roblox.client";
import { createTrackerConfig, type TrackerConfigDeps } from "./tracker-config.service";

const NOW = new Date("2026-10-22T12:00:00Z");
const G = "guild-1";

function robloxBadge(id: string, count = 500): RobloxBadge {
    return { id, name: `Badge ${id}`, description: "d", awardedCount: count };
}

function guildRow(id: string, over: Partial<GuildBadgeRow> = {}): GuildBadgeRow {
    return {
        guild_id: G,
        badge_id: id,
        ping_role_id: null,
        custom_description: null,
        accent_color: null,
        name: `Stored ${id}`,
        description: "d",
        icon_url: null,
        awarded_count: "10",
        deleted: false,
        ...over,
    };
}

interface Setup {
    subs?: GuildBadgeRow[];
    stored?: string[];
    totalBadges?: number;
    fetch?: BadgeFetchResult;
    icons?: Map<string, string>;
    maxBadges?: number;
    guildCount?: number;
    channel?: string | null;
}

function make(setup: Setup = {}) {
    const calls: string[] = [];
    const subs = [...(setup.subs ?? [])];
    const log = {
        fetchBadge: 0,
        fetchIcons: [] as string[][],
        upserts: [] as unknown[],
        intervals: [] as number[],
        descriptions: [] as (string | null)[],
        colors: [] as (number | null)[],
    };
    const deps: TrackerConfigDeps = {
        now: () => NOW,
        maxBadges: setup.maxBadges ?? 200,
        roblox: {
            async fetchBadge(id) {
                log.fetchBadge++;
                return setup.fetch ?? { kind: "ok", badge: robloxBadge(id) };
            },
            async fetchIcons(ids) {
                log.fetchIcons.push(ids);
                return setup.icons ?? new Map(ids.map((i) => [i, `https://img/${i}.png`]));
            },
        },
        repo: {
            async getBadge(id) {
                return (setup.stored ?? []).includes(id) ? ({ badge_id: id } as BadgeRow) : null;
            },
            async countBadges() {
                return setup.totalBadges ?? 0;
            },
            async upsertBadge(b, icon, now) {
                calls.push("upsert");
                log.upserts.push({ b, icon, now });
            },
            async getGuildBadges() {
                return subs;
            },
            async countGuildSubscriptions() {
                return setup.guildCount ?? subs.length;
            },
            async addSubscription(g, id, role) {
                calls.push(`add:${g}:${id}:${role}`);
            },
            async removeSubscription() {
                calls.push("remove");
                return true;
            },
            async setPingRole(_g, id, role) {
                calls.push(`role:${id}:${role}`);
                return true;
            },
            async setCustomDescription(_g, id, text) {
                log.descriptions.push(text);
                calls.push(`desc:${id}`);
                return true;
            },
            async setAccentColor(_g, _id, color) {
                log.colors.push(color);
                return true;
            },
            async getTrackerChannel() {
                return setup.channel ?? null;
            },
            async setTrackerChannel(g, ch) {
                calls.push(`channel:${g}:${ch}`);
            },
            async getTrackerSettings() {
                return { interval_minutes: 7, last_round_at: null };
            },
            async setIntervalMinutes(n) {
                log.intervals.push(n);
            },
        },
    };
    return { svc: createTrackerConfig(deps), calls, log };
}

async function rejection(p: Promise<unknown>): Promise<BadgeTrackerError> {
    try {
        await p;
    } catch (e) {
        expect(e).toBeInstanceOf(BadgeTrackerError);
        return e as BadgeTrackerError;
    }
    throw new Error("expected rejection");
}

describe("previewBadge", () => {
    test("rejects bad input", async () => {
        const err = await rejection(make().svc.previewBadge(G, "nope"));
        expect(err.message).toBe("That isn't a badge ID or a roblox.com/badges link.");
    });

    test("reports not found", async () => {
        const err = await rejection(make({ fetch: { kind: "not_found" } }).svc.previewBadge(G, "42"));
        expect(err.message).toBe("There's no badge with ID `42` on Roblox.");
    });

    test("reports rate limit and error as no answer", async () => {
        const results: BadgeFetchResult[] = [
            { kind: "rate_limited", retryAfterMs: null },
            { kind: "error", message: "x" },
        ];
        for (const fetch of results) {
            const err = await rejection(make({ fetch }).svc.previewBadge(G, "42"));
            expect(err.message).toBe("Roblox didn't answer. Try again in a minute.");
        }
    });

    test("rejects a duplicate before asking Roblox", async () => {
        const t = make({ subs: [guildRow("42")] });
        const err = await rejection(t.svc.previewBadge(G, "42"));
        expect(err.message).toBe("This server already tracks **Stored 42**.");
        expect(t.log.fetchBadge).toBe(0);
    });

    test("rejects at the per-server cap before asking Roblox", async () => {
        const t = make({ guildCount: 25 });
        const err = await rejection(t.svc.previewBadge(G, "42"));
        expect(err.message).toBe("This server already tracks 25 badges. Remove one to add another.");
        expect(t.log.fetchBadge).toBe(0);
    });

    test("rejects at the global cap for a new badge", async () => {
        const t = make({ totalBadges: 3, maxBadges: 3 });
        const err = await rejection(t.svc.previewBadge(G, "42"));
        expect(err.message).toBe("The bot already tracks 3 badges, its limit. Remove some to add more.");
        expect(t.log.fetchBadge).toBe(0);
    });

    test("an already stored badge ignores the global cap", async () => {
        const t = make({ totalBadges: 3, maxBadges: 3, stored: ["42"] });
        const preview = await t.svc.previewBadge(G, "42");
        expect(preview.badge.id).toBe("42");
    });

    test("fetches the icon with fetchIcons([id])", async () => {
        const t = make();
        const preview = await t.svc.previewBadge(G, "https://www.roblox.com/badges/42/x");
        expect(t.log.fetchIcons).toEqual([["42"]]);
        expect(preview.iconUrl).toBe("https://img/42.png");
    });

    test("iconUrl is null when no icon comes back", async () => {
        const preview = await make({ icons: new Map() }).svc.previewBadge(G, "42");
        expect(preview.iconUrl).toBeNull();
    });
});

describe("trackBadge", () => {
    test("upserts the badge with the preview's count as baseline then adds the subscription", async () => {
        const t = make();
        const preview = { badge: robloxBadge("42", 777), iconUrl: "u" };
        await t.svc.trackBadge(G, preview, "role-1");
        expect(t.calls).toEqual(["upsert", `add:${G}:42:role-1`]);
        expect(t.log.upserts).toEqual([{ b: preview.badge, icon: "u", now: NOW }]);
    });

    test("re-checks the per-server cap", async () => {
        const t = make({ guildCount: 25 });
        const err = await rejection(t.svc.trackBadge(G, { badge: robloxBadge("42"), iconUrl: null }, null));
        expect(err.message).toBe("This server already tracks 25 badges. Remove one to add another.");
        expect(t.calls).toEqual([]);
    });

    test("re-checks the duplicate", async () => {
        const t = make({ subs: [guildRow("42")] });
        const err = await rejection(t.svc.trackBadge(G, { badge: robloxBadge("42"), iconUrl: null }, null));
        expect(err.message).toBe("This server already tracks **Stored 42**.");
    });

    test("tracking an already stored badge is not blocked by the global cap and uses the upsert", async () => {
        const t = make({ stored: ["42"], totalBadges: 5, maxBadges: 5 });
        await t.svc.trackBadge(G, { badge: robloxBadge("42"), iconUrl: null }, null);
        expect(t.calls).toEqual(["upsert", `add:${G}:42:null`]);
    });
});

describe("existing subscriptions", () => {
    test("removeBadge returns the name", async () => {
        const t = make({ subs: [guildRow("42")] });
        expect(await t.svc.removeBadge(G, "42")).toBe("Stored 42");
        expect(t.calls).toEqual(["remove"]);
    });

    test("methods throw not-tracked for an unknown id", async () => {
        const t = make();
        const msg = "This server doesn't track a badge with ID `42`.";
        expect((await rejection(t.svc.removeBadge(G, "42"))).message).toBe(msg);
        expect((await rejection(t.svc.setPingRole(G, "42", null))).message).toBe(msg);
        expect((await rejection(t.svc.setDescription(G, "42", "x"))).message).toBe(msg);
    });

    test("methods reject bad input", async () => {
        const t = make({ subs: [guildRow("42")] });
        const msg = "That isn't a badge ID or a roblox.com/badges link.";
        expect((await rejection(t.svc.removeBadge(G, "zzz"))).message).toBe(msg);
        expect((await rejection(t.svc.setPingRole(G, "zzz", null))).message).toBe(msg);
        expect((await rejection(t.svc.setDescription(G, "zzz", "x"))).message).toBe(msg);
    });

    test("setPingRole returns the name", async () => {
        const t = make({ subs: [guildRow("42")] });
        expect(await t.svc.setPingRole(G, "42", "r1")).toBe("Stored 42");
        expect(t.calls).toEqual(["role:42:r1"]);
    });

    test("setDescription trims and stores text", async () => {
        const t = make({ subs: [guildRow("42")] });
        expect(await t.svc.setDescription(G, "42", "  hello  ")).toBe("Stored 42");
        expect(t.log.descriptions).toEqual(["hello"]);
    });

    test("setDescription with empty, whitespace or null text stores null", async () => {
        const t = make({ subs: [guildRow("42")] });
        await t.svc.setDescription(G, "42", "");
        await t.svc.setDescription(G, "42", "   ");
        await t.svc.setDescription(G, "42", null);
        expect(t.log.descriptions).toEqual([null, null, null]);
    });

    test("setDescription rejects text over 300 characters", async () => {
        const t = make({ subs: [guildRow("42")] });
        const err = await rejection(t.svc.setDescription(G, "42", "a".repeat(301)));
        expect(err.message).toBe("Descriptions can be up to 300 characters.");
        await t.svc.setDescription(G, "42", "a".repeat(300));
        expect(t.log.descriptions).toHaveLength(1);
    });

    test("setColor stores the hex as an integer and returns the name", async () => {
        const t = make({ subs: [guildRow("42")] });
        expect(await t.svc.setColor(G, "42", "#7CF5FF")).toBe("Stored 42");
        expect(t.log.colors).toEqual([0x7cf5ff]);
    });

    test("setColor with empty or null resets to the default", async () => {
        const t = make({ subs: [guildRow("42")] });
        await t.svc.setColor(G, "42", "  ");
        await t.svc.setColor(G, "42", null);
        expect(t.log.colors).toEqual([null, null]);
    });

    test("setColor rejects a bad hex without saving", async () => {
        const t = make({ subs: [guildRow("42")] });
        const err = await rejection(t.svc.setColor(G, "42", "red"));
        expect(err.message).toBe("Colors are hex codes like `#7CF5FF`.");
        expect(t.log.colors).toEqual([]);
    });

    test("setColor on an untracked badge throws not-tracked", async () => {
        const t = make();
        const err = await rejection(t.svc.setColor(G, "42", "#7CF5FF"));
        expect(err.message).toBe("This server doesn't track a badge with ID `42`.");
    });
});

describe("settings", () => {
    test("setIntervalMinutes accepts 1-60", async () => {
        const t = make();
        await t.svc.setIntervalMinutes(1);
        await t.svc.setIntervalMinutes(60);
        expect(t.log.intervals).toEqual([1, 60]);
    });

    test("setIntervalMinutes rejects out of range and non-integers", async () => {
        const t = make();
        for (const n of [0, 61, -1, 2.5, Number.NaN]) {
            const err = await rejection(t.svc.setIntervalMinutes(n));
            expect(err.message).toBe("The interval must be between 1 and 60 minutes.");
        }
        expect(t.log.intervals).toEqual([]);
    });

    test("setChannel stores the channel", async () => {
        const t = make();
        await t.svc.setChannel(G, "c1");
        expect(t.calls).toEqual([`channel:${G}:c1`]);
    });

    test("getOverview combines channel, interval and badges", async () => {
        const t = make({ subs: [guildRow("42")], channel: "c9" });
        const overview = await t.svc.getOverview(G);
        expect(overview).toEqual({ channelId: "c9", intervalMinutes: 7, badges: [guildRow("42")] });
    });
});
