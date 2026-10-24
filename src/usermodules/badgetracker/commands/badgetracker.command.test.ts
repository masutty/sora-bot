import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import type { GuildCommandContext } from "@/define";
import { NO_PINGS } from "@/utils/format";
import type { SendResult } from "../services/poller.service";
import type { BadgePreview, TrackerConfig, TrackerOverview } from "../services/tracker-config.service";
import type { GuildBadgeRow } from "../types";
import { TEST_LINE } from "../views/award-post";
import { type BadgeTrackerDeps, buildBadgeTrackerOptions, runBadgeTracker } from "./badgetracker.command";

describe("buildBadgeTrackerOptions", () => {
    const json = buildBadgeTrackerOptions().setName("badgetracker").setDescription("test").toJSON();
    const sub = (name: string) => json.options?.find((o) => o.name === name) as { options?: Record<string, unknown>[] } | undefined;
    const flags = (name: string) => sub(name)?.options?.map((o) => [o.name, o.required ?? false]);

    test("has the 10 subcommands", () => {
        expect(json.options?.map((o) => o.name)).toEqual([
            "settings",
            "add",
            "remove",
            "list",
            "channel",
            "role",
            "description",
            "color",
            "test",
            "interval",
        ]);
    });

    test("required flags", () => {
        expect(flags("add")).toEqual([
            ["id", true],
            ["role", false],
        ]);
        expect(flags("remove")).toEqual([["id", true]]);
        expect(flags("channel")).toEqual([["channel", true]]);
        expect(flags("role")).toEqual([
            ["id", true],
            ["role", false],
        ]);
        expect(flags("description")).toEqual([
            ["id", true],
            ["text", false],
        ]);
    });

    test("channel is limited to text and announcement channels", () => {
        expect(sub("channel")?.options?.[0]?.channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    });

    test("interval is limited to 1-60 minutes", () => {
        const opt = sub("interval")?.options?.[0];
        expect(opt?.required).toBe(true);
        expect(opt?.min_value).toBe(1);
        expect(opt?.max_value).toBe(60);
    });

    test("description text is capped at 300 characters", () => {
        expect(sub("description")?.options?.[1]?.max_length).toBe(300);
    });
});

const overview: TrackerOverview = { channelId: "c1", intervalMinutes: 5, badges: [] };

function setup(opts: {
    sub: string;
    args?: Record<string, unknown>;
    status?: string;
    mentionable?: boolean;
    overview?: TrackerOverview;
    sendResult?: SendResult;
}) {
    const calls: unknown[][] = [];
    // biome-ignore lint/suspicious/noExplicitAny: fake send payloads are inspected loosely
    const sends: any[][] = [];
    const config: TrackerConfig = {
        previewBadge: async (...a) => {
            calls.push(["previewBadge", ...a]);
            return { badge: { id: "1", name: "Winner", description: "", awardedCount: 0 }, iconUrl: null } satisfies BadgePreview;
        },
        trackBadge: async (...a) => void calls.push(["trackBadge", a[0], a[2]]),
        removeBadge: async (...a) => {
            calls.push(["removeBadge", ...a]);
            return "Winner";
        },
        setChannel: async (...a) => void calls.push(["setChannel", ...a]),
        setPingRole: async (...a) => {
            calls.push(["setPingRole", ...a]);
            return "Winner";
        },
        setDescription: async (...a) => {
            calls.push(["setDescription", ...a]);
            return "Winner";
        },
        setColor: async (...a) => {
            calls.push(["setColor", ...a]);
            return "Winner";
        },
        setIntervalMinutes: async (...a) => void calls.push(["setIntervalMinutes", ...a]),
        getOverview: async (...a) => {
            calls.push(["getOverview", ...a]);
            return opts.overview ?? overview;
        },
    };
    const deps: BadgeTrackerDeps = {
        config,
        postStatus: () => (opts.status ?? "ok") as ReturnType<BadgeTrackerDeps["postStatus"]>,
        canMention: () => opts.mentionable ?? true,
        send: async (channelId, payload) => {
            sends.push([channelId, payload]);
            return opts.sendResult ?? "sent";
        },
    };
    // biome-ignore lint/suspicious/noExplicitAny: fake reply payloads are inspected loosely
    const replies: any[] = [];
    const opened: unknown[][] = [];
    const defers: unknown[] = [];
    const a = opts.args ?? {};
    const ctx = {
        client: {},
        guild: { id: "g1" },
        args: {
            getSubcommand: () => opts.sub,
            getString: (n: string) => (a[n] as string) ?? null,
            getInteger: (n: string) => (a[n] as number) ?? null,
            getRole: async (n: string) => (a[n] ? { id: a[n] } : null),
            getChannel: async (n: string) => (a[n] ? { id: a[n] } : null),
        },
        defer: async (o?: unknown) => void defers.push(o),
        reply: async (p: unknown) => void replies.push(p),
        open: async (...x: unknown[]) => void opened.push(x),
    } as unknown as GuildCommandContext;
    return { ctx, deps, calls, replies, opened, defers, sends };
}

const text = (p: unknown) => JSON.stringify(p);

describe("runBadgeTracker", () => {
    test("settings defers publicly and opens the View", async () => {
        const t = setup({ sub: "settings" });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.defers).toEqual([undefined]);
        expect(t.opened).toHaveLength(1);
        expect(t.opened[0]?.[1]).toBeUndefined();
        expect(t.replies).toHaveLength(0);
    });

    test("add previews, tracks with the role and confirms", async () => {
        const t = setup({ sub: "add", args: { id: "1", role: "r1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.defers).toEqual([{ ephemeral: true }]);
        expect(t.calls).toEqual([
            ["previewBadge", "g1", "1"],
            ["trackBadge", "g1", "r1"],
        ]);
        expect(text(t.replies[0])).toContain("Now tracking **Winner**.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("add without a role tracks with null", async () => {
        const t = setup({ sub: "add", args: { id: "1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls[1]).toEqual(["trackBadge", "g1", null]);
    });

    test("add refuses a role the bot cannot mention", async () => {
        const t = setup({ sub: "add", args: { id: "1", role: "r1" }, mentionable: false });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([]);
        expect(text(t.replies[0])).toContain("I can't ping <@&r1>. Make it mentionable or give me the Mention Everyone permission.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("remove", async () => {
        const t = setup({ sub: "remove", args: { id: "1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([["removeBadge", "g1", "1"]]);
        expect(text(t.replies[0])).toContain("Stopped tracking **Winner**.");
    });

    test("list replies with the read-only overview and no pings", async () => {
        const t = setup({ sub: "list" });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.defers).toEqual([{ ephemeral: true }]);
        expect(t.calls).toEqual([["getOverview", "g1"]]);
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("channel sets the channel without a warning when postable", async () => {
        const t = setup({ sub: "channel", args: { channel: "c9" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([["setChannel", "g1", "c9"]]);
        expect(text(t.replies[0])).toContain("Updates go to <#c9>.");
        expect(text(t.replies[0])).not.toContain("⚠️");
    });

    test("channel warns when the bot cannot post there", async () => {
        const t = setup({ sub: "channel", args: { channel: "c9" }, status: "no_permission" });
        await runBadgeTracker(t.ctx, t.deps);
        expect(text(t.replies[0])).toContain(
            "Updates go to <#c9>.\\n⚠️ I can't post in <#c9>. Updates are paused until I can send messages there.",
        );
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("role sets the ping and never pings the role", async () => {
        const t = setup({ sub: "role", args: { id: "1", role: "r1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([["setPingRole", "g1", "1", "r1"]]);
        expect(text(t.replies[0])).toContain("Winner pings <@&r1>.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("role without a role clears the ping", async () => {
        const t = setup({ sub: "role", args: { id: "1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([["setPingRole", "g1", "1", null]]);
        expect(text(t.replies[0])).toContain("Winner has no ping.");
    });

    test("role refuses a role the bot cannot mention", async () => {
        const t = setup({ sub: "role", args: { id: "1", role: "r1" }, mentionable: false });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([]);
        expect(text(t.replies[0])).toContain("I can't ping <@&r1>.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("description sets and resets", async () => {
        const set = setup({ sub: "description", args: { id: "1", text: "Hi" } });
        await runBadgeTracker(set.ctx, set.deps);
        expect(set.calls).toEqual([["setDescription", "g1", "1", "Hi"]]);
        expect(text(set.replies[0])).toContain("Description for Winner updated.");

        const reset = setup({ sub: "description", args: { id: "1" } });
        await runBadgeTracker(reset.ctx, reset.deps);
        expect(reset.calls).toEqual([["setDescription", "g1", "1", null]]);
        expect(text(reset.replies[0])).toContain("Winner uses the Roblox description again.");
    });

    test("interval", async () => {
        const t = setup({ sub: "interval", args: { minutes: 10 } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toEqual([["setIntervalMinutes", 10]]);
        expect(text(t.replies[0])).toContain("Badges are checked every 10 minutes.");
    });
});

const row = (id: string, over: Partial<GuildBadgeRow> = {}): GuildBadgeRow => ({
    guild_id: "g1",
    badge_id: id,
    ping_role_id: "r1",
    custom_description: null,
    accent_color: null,
    name: `Badge ${id}`,
    description: "",
    icon_url: null,
    awarded_count: "10",
    deleted: false,
    ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: inspecting raw JSON
const postJson = (payload: any) => payload.components[0].toJSON();

async function rejects(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error("expected rejection");
}

describe("color", () => {
    test("sets a hex and says which color", async () => {
        const t = setup({ sub: "color", args: { id: "1", hex: "#7cf5ff" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toContainEqual(["setColor", "g1", "1", "#7cf5ff"]);
        expect(text(t.replies[0])).toContain("Winner uses #7CF5FF.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("without a hex resets to the default", async () => {
        const t = setup({ sub: "color", args: { id: "1" } });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.calls).toContainEqual(["setColor", "g1", "1", null]);
        expect(text(t.replies[0])).toContain("Winner uses the default color.");
    });
});

describe("test", () => {
    const withBadges = (badges: GuildBadgeRow[], channelId: string | null = "c1"): TrackerOverview => ({
        channelId,
        intervalMinutes: 5,
        badges,
    });

    test("sends one marked, ping-free card per live badge, in its own color", async () => {
        const t = setup({
            sub: "test",
            overview: withBadges([row("1", { accent_color: 0x7cf5ff }), row("2"), row("3", { deleted: true })]),
        });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.sends.map(([ch]) => ch)).toEqual(["c1", "c1"]);
        for (const [, payload] of t.sends) {
            expect(postJson(payload).content).toBe(TEST_LINE);
            expect(JSON.stringify(payload.components[1].toJSON())).not.toContain("<@&");
            expect(payload.allowedMentions).toEqual({ parse: [], roles: [] });
        }
        expect(t.sends[0]?.[1].components[1].toJSON().accent_color).toBe(0x7cf5ff);
        expect(text(t.replies[0])).toContain("Sent 2 test posts to <#c1>.");
        expect(t.replies[0].allowedMentions).toEqual(NO_PINGS);
    });

    test("with an id sends only that badge", async () => {
        const t = setup({ sub: "test", args: { id: "2" }, overview: withBadges([row("1"), row("2")]) });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.sends).toHaveLength(1);
        expect(text(t.replies[0])).toContain("Sent a test post for **Badge 2** to <#c1>.");
    });

    test("stops at the first failed send and says so", async () => {
        const t = setup({ sub: "test", sendResult: "forbidden", overview: withBadges([row("1"), row("2")]) });
        await runBadgeTracker(t.ctx, t.deps);
        expect(t.sends).toHaveLength(1);
        expect(text(t.replies[0])).toContain("Sent 0 of 2 test posts to <#c1>. I couldn't send the rest.");
    });

    test("refuses without a channel, without permission, with nothing to test, or a deleted/untracked id", async () => {
        const cases: [Parameters<typeof setup>[0], string][] = [
            [{ sub: "test", overview: withBadges([row("1")], null) }, "Pick a channel first with `/badgetracker channel`."],
            [
                { sub: "test", status: "no_permission", overview: withBadges([row("1")]) },
                "I can't post in <#c1>. Give me permission to send messages there first.",
            ],
            [{ sub: "test", overview: withBadges([]) }, "There are no badges to test. Add one first."],
            [
                { sub: "test", args: { id: "1" }, overview: withBadges([row("1", { deleted: true })]) },
                "**Badge 1** was deleted on Roblox, so there's nothing to test.",
            ],
            [{ sub: "test", args: { id: "9" }, overview: withBadges([row("1")]) }, "This server doesn't track a badge with ID `9`."],
        ];
        for (const [opts, message] of cases) {
            const t = setup(opts);
            expect(await rejects(runBadgeTracker(t.ctx, t.deps))).toBe(message);
            expect(t.sends).toHaveLength(0);
        }
    });
});
