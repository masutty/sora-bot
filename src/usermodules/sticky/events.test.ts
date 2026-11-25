import { afterEach, expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import { createStickyEvents } from "./events";
import type { Reposter } from "./services/repost.service";
import { stickyCache } from "./services/sticky-cache";
import type { StickyRow } from "./types";

const row: StickyRow = {
    guild_id: "g1",
    channel_id: "c1",
    content: "Rules",
    mode: "all",
    delay_seconds: 300,
    message_id: "m1",
    last_posted_at: null,
    created_by: "u1",
    created_at: new Date(0),
};

const client = { user: { id: "bot" } } as unknown as BotClient;

function setup() {
    const messages: unknown[][] = [];
    const deleted: string[] = [];
    const removed: string[] = [];
    let touched = 0;
    const reposter = {
        onMessage: async (...a: unknown[]) => void messages.push(a),
        onMessageDeleted: (_channelId: string, id: string) => void deleted.push(id),
        postNow: async () => ({ posted: true as const }),
    } as Reposter;
    const events = createStickyEvents({
        reposter: () => {
            touched++;
            return reposter;
        },
        deleteRow: async (id) => void removed.push(id),
    });
    return { events, messages, deleted, removed, touched: () => touched };
}

const msg = (channelId: string, extra: object = {}) => ({
    guild: {},
    channelId,
    author: { id: "u", bot: false },
    webhookId: null,
    ...extra,
});

afterEach(() => stickyCache.clear());

test("channelDelete removes the row and the cache entry of a sticky channel", async () => {
    const t = setup();
    stickyCache.set(row);
    await t.events.channelDelete(client, { id: "c1" });
    expect(t.removed).toEqual(["c1"]);
    expect(stickyCache.get("c1")).toBeUndefined();
});

test("channelDelete ignores a channel without a sticky", async () => {
    const t = setup();
    await t.events.channelDelete(client, { id: "other" });
    expect(t.removed).toEqual([]);
});

test("messageCreate in a channel without a sticky never touches the reposter", async () => {
    const t = setup();
    await t.events.messageCreate(client, msg("c9"));
    expect(t.touched()).toBe(0);
});

test("messageCreate outside a guild is ignored", async () => {
    const t = setup();
    stickyCache.set(row);
    await t.events.messageCreate(client, msg("c1", { guild: null }));
    expect(t.messages).toEqual([]);
});

test("messageCreate in a sticky channel asks the reposter with the bot id", async () => {
    const t = setup();
    stickyCache.set(row);
    await t.events.messageCreate(client, msg("c1"));
    expect(t.messages).toEqual([["c1", { authorId: "u", authorIsBot: false, webhookId: null }, "bot"]]);
});

test("messageDelete tells the reposter only for sticky channels", async () => {
    const t = setup();
    await t.events.messageDelete(client, { guildId: "g1", channelId: "c9", id: "m1" });
    expect(t.deleted).toEqual([]);
    stickyCache.set(row);
    await t.events.messageDelete(client, { guildId: "g1", channelId: "c1", id: "m1" });
    expect(t.deleted).toEqual(["m1"]);
});

test("messageDeleteBulk tells the reposter about every deleted id, only for sticky channels", async () => {
    const t = setup();
    const ids = new Map([
        ["m1", 1],
        ["m2", 2],
    ]);
    await t.events.messageDeleteBulk(client, ids, { id: "c9", guildId: "g1" });
    expect(t.deleted).toEqual([]);
    stickyCache.set(row);
    await t.events.messageDeleteBulk(client, ids, { id: "c1", guildId: "g1" });
    expect(t.deleted).toEqual(["m1", "m2"]);
});
