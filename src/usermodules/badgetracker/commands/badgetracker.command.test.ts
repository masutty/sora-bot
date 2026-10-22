import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import type { GuildCommandContext } from "@/define";
import { NO_PINGS } from "@/utils/format";
import type { BadgePreview, TrackerConfig, TrackerOverview } from "../services/tracker-config.service";
import { type BadgeTrackerDeps, buildBadgeTrackerOptions, runBadgeTracker } from "./badgetracker.command";

describe("buildBadgeTrackerOptions", () => {
    const json = buildBadgeTrackerOptions().setName("badgetracker").setDescription("test").toJSON();
    const sub = (name: string) => json.options?.find((o) => o.name === name) as { options?: Record<string, unknown>[] } | undefined;
    const flags = (name: string) => sub(name)?.options?.map((o) => [o.name, o.required ?? false]);

    test("has the 8 subcommands", () => {
        expect(json.options?.map((o) => o.name)).toEqual([
            "settings",
            "add",
            "remove",
            "list",
            "channel",
            "role",
            "description",
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

function setup(opts: { sub: string; args?: Record<string, unknown>; status?: string; mentionable?: boolean }) {
    const calls: unknown[][] = [];
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
        setIntervalMinutes: async (...a) => void calls.push(["setIntervalMinutes", ...a]),
        getOverview: async (...a) => {
            calls.push(["getOverview", ...a]);
            return overview;
        },
    };
    const deps: BadgeTrackerDeps = {
        config,
        postStatus: () => (opts.status ?? "ok") as ReturnType<BadgeTrackerDeps["postStatus"]>,
        canMention: () => opts.mentionable ?? true,
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
    return { ctx, deps, calls, replies, opened, defers };
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
