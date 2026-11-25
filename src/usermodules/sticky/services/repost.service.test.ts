import { beforeEach, expect, test } from "bun:test";
import { NO_PINGS } from "@/utils/format";
import type { StickyRow } from "../types";
import { countsForRepost, createReposter, defaultRepostDeps, delayPassed, type RepostDeps } from "./repost.service";
import { stickyCache } from "./sticky-cache";

const T0 = new Date("2026-11-24T12:00:00Z");
const minutesAgo = (n: number) => new Date(T0.getTime() - n * 60_000);
const BOT = "bot";
const human = { authorId: "u1", authorIsBot: false, webhookId: null };

function sticky(over: Partial<StickyRow> = {}): StickyRow {
    return {
        guild_id: "g1",
        channel_id: "c1",
        content: "rules",
        mode: "all",
        delay_seconds: 3600,
        message_id: "old",
        last_posted_at: minutesAgo(61),
        created_by: "u0",
        created_at: minutesAgo(1000),
        ...over,
    };
}

interface Harness {
    deps: RepostDeps;
    sent: Array<{ channelId: string; content: string }>;
    removed: string[];
    saved: Array<{ channelId: string; messageId: string; at: Date }>;
    cleared: string[];
    logged: Error[];
    failSend: boolean;
    canManage: boolean;
    clock?: Date;
    order: string[];
}

let h: Harness;
beforeEach(() => {
    stickyCache.clear();
    let counter = 0;
    h = { sent: [], removed: [], saved: [], cleared: [], logged: [], failSend: false, canManage: true, order: [] } as unknown as Harness;
    h.deps = {
        now: () => h.clock ?? T0,
        async canManage() {
            return h.canManage;
        },
        async send(channelId, content) {
            await Promise.resolve();
            if (h.failSend) throw new Error("Missing Permissions");
            h.sent.push({ channelId, content });
            h.order.push("send");
            return `new${++counter}`;
        },
        async remove(_channelId, messageId) {
            h.removed.push(messageId);
            h.order.push("remove");
        },
        async save(channelId, messageId, at) {
            h.saved.push({ channelId, messageId, at });
        },
        async clearMessage(channelId) {
            h.cleared.push(channelId);
        },
        log: (err) => h.logged.push(err),
    };
});

test("countsForRepost ignores the bot itself and, in nobots, any bot or webhook", () => {
    expect(countsForRepost({ authorId: BOT, authorIsBot: true, webhookId: null }, "all", BOT)).toBe(false);
    expect(countsForRepost({ authorId: "b2", authorIsBot: true, webhookId: null }, "all", BOT)).toBe(true);
    expect(countsForRepost({ authorId: "b2", authorIsBot: true, webhookId: null }, "nobots", BOT)).toBe(false);
    expect(countsForRepost({ authorId: "w", authorIsBot: false, webhookId: "wh" }, "nobots", BOT)).toBe(false);
    expect(countsForRepost(human, "nobots", BOT)).toBe(true);
});

test("delayPassed is true without a posted message or timestamp", () => {
    expect(delayPassed(sticky({ message_id: null }), T0)).toBe(true);
    expect(delayPassed(sticky({ last_posted_at: null }), T0)).toBe(true);
    expect(delayPassed(sticky({ last_posted_at: minutesAgo(10) }), T0)).toBe(false);
    expect(delayPassed(sticky({ last_posted_at: minutesAgo(60) }), T0)).toBe(true);
});

test("the bot's own message does not repost; another bot does in all mode", async () => {
    stickyCache.set(sticky());
    const r = createReposter(h.deps);
    await r.onMessage("c1", { authorId: BOT, authorIsBot: true, webhookId: null }, BOT);
    expect(h.sent).toHaveLength(0);
    await r.onMessage("c1", { authorId: "b2", authorIsBot: true, webhookId: null }, BOT);
    expect(h.sent).toHaveLength(1);
});

test("nobots ignores other bots and webhooks", async () => {
    stickyCache.set(sticky({ mode: "nobots" }));
    const r = createReposter(h.deps);
    await r.onMessage("c1", { authorId: "b2", authorIsBot: true, webhookId: null }, BOT);
    await r.onMessage("c1", { authorId: "w", authorIsBot: false, webhookId: "wh" }, BOT);
    expect(h.sent).toHaveLength(0);
});

test("a channel without a sticky is ignored", async () => {
    await createReposter(h.deps).onMessage("c9", human, BOT);
    expect(h.sent).toHaveLength(0);
});

test("inside the delay nothing is sent; after it the old message is removed and the new one saved", async () => {
    stickyCache.set(sticky({ last_posted_at: minutesAgo(10) }));
    const r = createReposter(h.deps);
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(0);

    stickyCache.set(sticky({ last_posted_at: minutesAgo(61) }));
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toEqual([{ channelId: "c1", content: "rules" }]);
    expect(h.removed).toEqual(["old"]);
    expect(h.saved).toEqual([{ channelId: "c1", messageId: "new1", at: T0 }]);
    expect(stickyCache.get("c1")).toMatchObject({ message_id: "new1", last_posted_at: T0 });
});

test("a burst in one tick sends exactly once", async () => {
    stickyCache.set(sticky());
    const r = createReposter(h.deps);
    await Promise.all([r.onMessage("c1", human, BOT), r.onMessage("c1", human, BOT), r.onMessage("c1", human, BOT)]);
    expect(h.sent).toHaveLength(1);
});

test("deleting the posted message makes the next counted message repost inside the delay", async () => {
    stickyCache.set(sticky({ last_posted_at: minutesAgo(1) }));
    const r = createReposter(h.deps);
    r.onMessageDeleted("c1", "other");
    expect(stickyCache.get("c1")?.message_id).toBe("old");
    r.onMessageDeleted("c1", "old");
    expect(stickyCache.get("c1")?.message_id).toBeNull();
    expect(h.cleared).toEqual(["c1"]);
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(1);
    expect(h.removed).toEqual([]);
});

test("a failing send is logged, keeps the old state, does not throw and backs off one delay", async () => {
    stickyCache.set(sticky());
    h.failSend = true;
    const r = createReposter(h.deps);
    await r.onMessage("c1", human, BOT);
    expect(h.logged).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(h.removed).toEqual([]);
    expect(stickyCache.get("c1")?.message_id).toBe("old");
    h.failSend = false;
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(0);
    h.clock = new Date(T0.getTime() + 3600_000);
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(1);
});

test("a failing send of a sticky without a posted message does not retry on every message", async () => {
    stickyCache.set(sticky({ message_id: null, last_posted_at: null }));
    h.failSend = true;
    const r = createReposter(h.deps);
    await r.onMessage("c1", human, BOT);
    await r.onMessage("c1", human, BOT);
    await r.onMessage("c1", human, BOT);
    expect(h.logged).toHaveLength(1);
});

test("the new copy is sent before the old one is removed", async () => {
    stickyCache.set(sticky());
    await createReposter(h.deps).onMessage("c1", human, BOT);
    expect(h.order).toEqual(["send", "remove"]);
    expect(h.removed).toEqual(["old"]);
});

test("a failing delete of the old copy is logged and the new copy stays saved", async () => {
    stickyCache.set(sticky());
    h.deps.remove = async () => {
        throw new Error("Missing Permissions");
    };
    await createReposter(h.deps).onMessage("c1", human, BOT);
    expect(h.logged).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    expect(stickyCache.get("c1")?.message_id).toBe("new1");
});

test("without Manage Messages nothing is posted and the old copy stays", async () => {
    stickyCache.set(sticky());
    h.canManage = false;
    const r = createReposter(h.deps);
    await r.onMessage("c1", human, BOT);
    await r.onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(0);
    expect(h.removed).toEqual([]);
    expect(h.logged).toHaveLength(1);
    expect(stickyCache.get("c1")?.message_id).toBe("old");
});

test("postNow posts regardless of the delay", async () => {
    const row = sticky({ message_id: null, last_posted_at: null });
    stickyCache.set(row);
    await createReposter(h.deps).postNow(row);
    expect(h.sent).toHaveLength(1);
    expect(stickyCache.get("c1")?.message_id).toBe("new1");
});

test("postNow reports whether the post went out", async () => {
    const row = sticky({ message_id: null, last_posted_at: null });
    stickyCache.set(row);
    expect(await createReposter(h.deps).postNow(row)).toEqual({ posted: true });
    h.canManage = false;
    expect(await createReposter(h.deps).postNow(row)).toMatchObject({ posted: false });
    h.canManage = true;
    h.failSend = true;
    expect(await createReposter(h.deps).postNow(row)).toMatchObject({ posted: false });
});

test("a cache loaded from the database obeys the delay on the first message", async () => {
    stickyCache.load([sticky({ delay_seconds: 300, last_posted_at: minutesAgo(1) })]);
    await createReposter(h.deps).onMessage("c1", human, BOT);
    expect(h.sent).toHaveLength(0);
});

test("the default send posts with NO_PINGS", async () => {
    const calls: unknown[] = [];
    const channel = {
        isTextBased: () => true,
        send: async (payload: unknown) => {
            calls.push(payload);
            return { id: "m1" };
        },
    };
    const client = { channels: { fetch: async () => channel } } as never;
    const id = await defaultRepostDeps(client).send("c1", "@everyone <@&5> hi");
    expect(id).toBe("m1");
    expect(calls).toEqual([{ content: "@everyone <@&5> hi", allowedMentions: NO_PINGS }]);
});
