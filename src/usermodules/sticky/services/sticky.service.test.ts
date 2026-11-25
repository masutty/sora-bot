import { beforeEach, expect, test } from "bun:test";
import { StickyError, type StickyRow } from "../types";
import type { PostResult } from "./repost.service";
import { createStickyService, savedLine } from "./sticky.service";
import { stickyCache } from "./sticky-cache";

const T0 = new Date("2026-11-24T12:00:00Z");

function row(over: Partial<StickyRow> = {}): StickyRow {
    return {
        guild_id: "g1",
        channel_id: "c1",
        content: "rules",
        mode: "all",
        delay_seconds: 300,
        message_id: null,
        last_posted_at: null,
        created_by: "u1",
        created_at: T0,
        ...over,
    };
}

let used = 0;
let limit = 5;
let posted: StickyRow[] = [];
let removedMessages: Array<[string, string]> = [];
let rows: Map<string, StickyRow>;

let postResult: PostResult = { posted: true };

function build() {
    const repo = {
        listAllStickies: async () => [...rows.values()],
        listGuildStickies: async () => [...rows.values()],
        countGuildStickies: async () => used,
        insertSticky: async (r: Pick<StickyRow, "channel_id" | "content" | "mode" | "delay_seconds" | "guild_id" | "created_by">) => {
            const created = row(r);
            rows.set(created.channel_id, created);
            return created;
        },
        updateSticky: async (channelId: string, patch: Partial<StickyRow>) => {
            const current = rows.get(channelId);
            if (!current) return null;
            const next = { ...current, ...patch };
            rows.set(channelId, next);
            return next;
        },
        deleteSticky: async (channelId: string) => {
            const current = rows.get(channelId) ?? null;
            rows.delete(channelId);
            return current;
        },
        guildUsage: async () => [],
    };
    return createStickyService({
        repo: repo as never,
        limits: { getGuildLimit: async () => limit },
        reposter: {
            postNow: async (s: StickyRow) => {
                posted.push(s);
                return postResult;
            },
            onMessage: async () => {},
            onMessageDeleted: () => {},
        },
        removeMessage: async (c, m) => {
            removedMessages.push([c, m]);
        },
    });
}

beforeEach(() => {
    postResult = { posted: true };
    stickyCache.clear();
    used = 0;
    limit = 5;
    posted = [];
    removedMessages = [];
    rows = new Map();
});

test("create at the limit is refused with the counts", async () => {
    used = 5;
    await expect(build().create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1" })).rejects.toThrow("5/5");
});

test("create above a lowered limit is refused and existing stickies stay", async () => {
    stickyCache.set(row({ channel_id: "old" }));
    used = 6;
    await expect(build().create({ guildId: "g1", channelId: "c2", content: "x", userId: "u1" })).rejects.toBeInstanceOf(StickyError);
    expect(stickyCache.get("old")).toBeDefined();
    expect(posted).toHaveLength(0);
});

test("create on a taken channel points to edit", async () => {
    stickyCache.set(row());
    await expect(build().create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1" })).rejects.toThrow("edit");
});

test("create stores defaults, fills the cache and posts right away", async () => {
    const created = await build().create({ guildId: "g1", channelId: "c1", content: "hello", userId: "u1" });
    expect(created.posted).toBe(true);
    expect(created.sticky).toMatchObject({ mode: "all", delay_seconds: 300, content: "hello" });
    expect(stickyCache.get("c1")).toBeDefined();
    expect(posted).toHaveLength(1);
});

test("create and edit report a failed post and keep the row", async () => {
    postResult = { posted: false, reason: "I need Send Messages and Manage Messages there." };
    const svc = build();
    const created = await svc.create({ guildId: "g1", channelId: "c1", content: "a", userId: "u1" });
    expect(created).toMatchObject({ posted: false, reason: "I need Send Messages and Manage Messages there." });
    expect(stickyCache.get("c1")).toBeDefined();
    expect(savedLine(created, "ok")).toBe(
        "Sticky saved for <#c1>, but I couldn't post it: I need Send Messages and Manage Messages there.",
    );
    expect((await svc.editContent("c1", "b")).posted).toBe(false);
});

test("a unique violation on insert becomes the already-has-a-sticky error", async () => {
    const svc = createStickyService({
        repo: {
            countGuildStickies: async () => 0,
            insertSticky: async () => {
                throw Object.assign(new Error("duplicate key"), { code: "23505" });
            },
        } as never,
        limits: { getGuildLimit: async () => 5 },
        reposter: { postNow: async () => ({ posted: true }), onMessage: async () => {}, onMessageDeleted: () => {} },
        removeMessage: async () => {},
    });
    await expect(svc.create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1" })).rejects.toThrow("already has a sticky");
});

test("editContent updates the cache and reposts", async () => {
    const svc = build();
    await svc.create({ guildId: "g1", channelId: "c1", content: "a", userId: "u1" });
    posted = [];
    await svc.editContent("c1", "b");
    expect(stickyCache.get("c1")?.content).toBe("b");
    expect(posted[0]?.content).toBe("b");
});

test("setMode and setDelay update the cache; an unlisted delay is refused", async () => {
    const svc = build();
    await svc.create({ guildId: "g1", channelId: "c1", content: "a", userId: "u1" });
    await svc.setMode("c1", "nobots");
    await svc.setDelay("c1", 3600);
    expect(stickyCache.get("c1")).toMatchObject({ mode: "nobots", delay_seconds: 3600 });
    await expect(svc.setDelay("c1", 123)).rejects.toBeInstanceOf(StickyError);
});

test("editing a channel without a sticky is a StickyError", async () => {
    await expect(build().editContent("nope", "x")).rejects.toThrow("no sticky");
});

test("remove clears the cache and deletes the posted message", async () => {
    const svc = build();
    await svc.create({ guildId: "g1", channelId: "c1", content: "a", userId: "u1" });
    rows.set("c1", row({ message_id: "m9" }));
    await svc.remove("c1");
    expect(stickyCache.get("c1")).toBeUndefined();
    expect(removedMessages).toEqual([["c1", "m9"]]);
});

test("overview reports used above the limit", async () => {
    rows = new Map([1, 2, 3, 4, 5, 6].map((n) => [`c${n}`, row({ channel_id: `c${n}` })]));
    limit = 5;
    expect(await build().overview("g1")).toMatchObject({ used: 6, limit: 5 });
});

test("create rejects an invalid mode or delay with a StickyError", async () => {
    const svc = build();
    await expect(
        svc.create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1", delaySeconds: Number.NaN }),
    ).rejects.toBeInstanceOf(StickyError);
    await expect(svc.create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1", delaySeconds: 60 })).rejects.toBeInstanceOf(
        StickyError,
    );
    await expect(svc.create({ guildId: "g1", channelId: "c1", content: "x", userId: "u1", mode: "nobot" as never })).rejects.toBeInstanceOf(
        StickyError,
    );
    expect(rows.size).toBe(0);
});
