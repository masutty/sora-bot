import { describe, expect, test } from "bun:test";
import type { GuildCommandContext } from "@/define";
import { UserFacingError } from "@/define";
import type { ChannelAccess } from "../services/channel-access";
import type { StickyService } from "../services/sticky.service";
import type { StickyRow } from "../types";
import { buildStickyOptions, runSticky } from "./sticky.command";

const row = (channelId: string): StickyRow => ({
    guild_id: "g1",
    channel_id: channelId,
    content: "Rules",
    mode: "all",
    delay_seconds: 3600,
    message_id: null,
    last_posted_at: null,
    created_by: "u1",
    created_at: new Date(0),
});

function setup(opts: {
    sub: string | null;
    stickies?: StickyRow[];
    limit?: number;
    access?: ChannelAccess;
    args?: Record<string, string>;
}) {
    const stickies = opts.stickies ?? [];
    const service = {
        overview: async () => ({ stickies, used: stickies.length, limit: opts.limit ?? 5 }),
        get: (id: string) => stickies.find((s) => s.channel_id === id),
    } as unknown as StickyService;
    const opened: unknown[][] = [];
    const replies: unknown[] = [];
    const args = opts.args ?? {};
    const ctx = {
        client: {},
        guild: { id: "g1" },
        user: { id: "u1" },
        args: { getSubcommand: () => opts.sub, getString: (n: string) => args[n] ?? null },
        raw: { kind: "prefix", message: { channelId: "c1" } },
        defer: async () => {},
        reply: async (p: unknown) => void replies.push(p),
        open: async (...x: unknown[]) => void opened.push(x),
    } as unknown as GuildCommandContext;
    const deps = { service, access: () => opts.access ?? ("ok" as ChannelAccess) };
    return { ctx, deps, opened, replies };
}

describe("buildStickyOptions", () => {
    const json = buildStickyOptions().setName("sticky").setDescription("test").toJSON();
    test("has the five subcommands", () => {
        expect(json.options?.map((o) => o.name)).toEqual(["create", "edit", "delete", "list", "panel"]);
    });
    test("create offers the modes and delays as choices", () => {
        const create = json.options?.[0] as unknown as { options: { name: string; choices: { name: string; value: string }[] }[] };
        expect(create.options[0]?.choices.map((c) => c.name)).toEqual(["All messages", "No bots"]);
        expect(create.options[1]?.choices.map((c) => c.name)).toEqual(["5 min", "1 hour", "3 hours", "6 hours", "12 hours", "24 hours"]);
    });
});

describe("runSticky", () => {
    test("a bare call opens the panel", async () => {
        const t = setup({ sub: null });
        await runSticky(t.ctx, t.deps);
        expect(t.opened).toHaveLength(1);
    });

    test("panel opens the panel", async () => {
        const t = setup({ sub: "panel" });
        await runSticky(t.ctx, t.deps);
        expect(t.opened).toHaveLength(1);
    });

    test("create in a channel with a sticky is a user-facing error", async () => {
        const t = setup({ sub: "create", stickies: [row("c1")] });
        const err = await runSticky(t.ctx, t.deps).catch((e) => e);
        expect(err).toBeInstanceOf(UserFacingError);
        expect(err.message).toContain("already has a sticky");
        expect(t.opened).toHaveLength(0);
    });

    test("create at the limit is refused", async () => {
        const t = setup({ sub: "create", stickies: [row("c2")], limit: 1 });
        await expect(runSticky(t.ctx, t.deps)).rejects.toThrow("1/1");
        expect(t.opened).toHaveLength(0);
    });

    test("create without channel access is refused", async () => {
        const t = setup({ sub: "create", access: "bot_missing_perms" });
        await expect(runSticky(t.ctx, t.deps)).rejects.toThrow("I need View Channel");
        expect(t.opened).toHaveLength(0);
    });

    test("create opens the capture", async () => {
        const t = setup({ sub: "create", args: { mode: "nobots", delay: "300" } });
        await runSticky(t.ctx, t.deps);
        expect(t.opened).toHaveLength(1);
    });

    test("create accepts short delays like 1h", async () => {
        const t = setup({ sub: "create", args: { mode: "all", delay: "1h" } });
        await runSticky(t.ctx, t.deps);
        expect(t.opened).toHaveLength(1);
    });

    test("create with a bad mode or delay is refused before the capture and lists the valid values", async () => {
        for (const [args, hint] of [
            [{ mode: "nobot" }, "all, nobots"],
            [{ delay: "60" }, "5m, 1h"],
            [{ delay: "banana" }, "5m, 1h"],
        ] as const) {
            const t = setup({ sub: "create", args });
            const err = await runSticky(t.ctx, t.deps).catch((e) => e);
            expect(err).toBeInstanceOf(UserFacingError);
            expect(err.message).toContain(hint);
            expect(t.opened).toHaveLength(0);
        }
    });

    test("edit without a sticky is an error", async () => {
        const t = setup({ sub: "edit" });
        await expect(runSticky(t.ctx, t.deps)).rejects.toThrow("This channel has no sticky.");
        expect(t.opened).toHaveLength(0);
    });

    test("edit and delete open a View when the sticky exists", async () => {
        for (const sub of ["edit", "delete"]) {
            const t = setup({ sub, stickies: [row("c1")] });
            await runSticky(t.ctx, t.deps);
            expect(t.opened).toHaveLength(1);
        }
    });

    test("delete without a sticky is an error", async () => {
        const t = setup({ sub: "delete" });
        await expect(runSticky(t.ctx, t.deps)).rejects.toThrow("This channel has no sticky.");
    });

    test("list replies with the list text and no components", async () => {
        const t = setup({ sub: "list", stickies: [row("c1")] });
        await runSticky(t.ctx, t.deps);
        const reply = t.replies[0] as { content: string; components?: unknown };
        expect(reply.content).toContain("**Stickies · 1/5**");
        expect(reply.content).toContain("<#c1> · All messages · 1 hour");
        expect(reply.components).toBeUndefined();
    });
});
