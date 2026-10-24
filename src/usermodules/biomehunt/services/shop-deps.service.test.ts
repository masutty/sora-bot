import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { PurchaseRow } from "../types";
import { defaultShopDeps } from "./shop-deps.service";

const purchase = {
    id: 7,
    code: "K7Q2MX",
    guild_id: "g1",
    buyer_discord_id: "u1",
    item_name: "Sticker",
    item_emoji: null,
    price: 5,
    kind: "manual",
    status: "pending",
    refund_reason: null,
    created_at: new Date(),
    post_channel_id: null,
    post_message_id: null,
} as unknown as PurchaseRow;

test("updateSalePost without a stored post does nothing", async () => {
    const client = { channels: { fetch: async () => expect.unreachable() } } as unknown as BotClient;
    await defaultShopDeps(client).updateSalePost(purchase);
});

test("addRole adds the role to the fetched member", async () => {
    const added: string[] = [];
    const member = { roles: { add: async (id: string) => void added.push(id) } };
    const client = { guilds: { cache: new Map([["g1", { members: { fetch: async () => member } }]]) } } as unknown as BotClient;
    await defaultShopDeps(client).addRole("g1", "u1", "r1");
    expect(added).toEqual(["r1"]);
});

test("removeRole ignores a member who left", async () => {
    const guild = {
        members: {
            fetch: async () => {
                throw Object.assign(new Error("Unknown Member"), { code: 10007 });
            },
        },
    };
    const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as BotClient;
    await defaultShopDeps(client).removeRole("g1", "u1", "r1");
});

test("removeRole rethrows other failures", async () => {
    const guild = { members: { fetch: async () => ({ roles: { remove: async () => Promise.reject(new Error("Missing Permissions")) } }) } };
    const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as BotClient;
    await expect(defaultShopDeps(client).removeRole("g1", "u1", "r1")).rejects.toThrow("Missing Permissions");
});

function salesClient(channels: Record<string, unknown>) {
    return {
        channels: {
            fetch: async (id: string) => {
                const c = channels[id];
                if (c instanceof Error) throw c;
                return c ?? null;
            },
        },
    } as unknown as BotClient;
}

function salesIo(sales: string | null, log: string | null) {
    const saved: unknown[][] = [];
    const warnings: { entry: { title: string; dedupKey?: string } }[] = [];
    const io = {
        salesChannelId: async () => sales,
        logChannelId: async () => log,
        savePost: async (...a: unknown[]) => void saved.push(a),
        log: async (_g: string, entry: { title: string; dedupKey?: string }) => void warnings.push({ entry }),
    };
    return { io, saved, warnings };
}

const textChannel = (id: string, sent: string[]) => ({
    type: 0,
    id,
    send: async () => {
        sent.push(id);
        return { id: `m-${id}` };
    },
});

test("postSale uses the sales channel and stores the message", async () => {
    const sent: string[] = [];
    const { io, saved } = salesIo("c1", "log1");
    const client = salesClient({ c1: textChannel("c1", sent), log1: textChannel("log1", sent) });
    await defaultShopDeps(client, io).postSale(purchase);
    expect(sent).toEqual(["c1"]);
    expect(saved).toEqual([[7, "c1", "m-c1"]]);
});

test("postSale falls back to the log channel", async () => {
    const sent: string[] = [];
    const { io, saved } = salesIo(null, "log1");
    await defaultShopDeps(salesClient({ log1: textChannel("log1", sent) }), io).postSale(purchase);
    expect(sent).toEqual(["log1"]);
    expect(saved).toEqual([[7, "log1", "m-log1"]]);
});

test("postSale with no channel at all does nothing", async () => {
    const { io, saved, warnings } = salesIo(null, null);
    await defaultShopDeps(salesClient({}), io).postSale(purchase);
    expect(saved).toEqual([]);
    expect(warnings).toEqual([]);
});

test("a failed post warns once with the shop-sales key and does not throw", async () => {
    const { io, saved, warnings } = salesIo("c1", null);
    const client = salesClient({ c1: Object.assign(new Error("Unknown Channel"), { code: 10003 }) });
    await defaultShopDeps(client, io).postSale(purchase);
    expect(saved).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.entry.dedupKey).toBe("shop-sales");
});
