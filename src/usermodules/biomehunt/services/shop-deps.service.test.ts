import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { PurchaseRow } from "../types";
import { defaultShopDeps } from "./shop-deps.service";

const purchase = { id: 7, code: "K7Q2MX", guild_id: "g1", post_channel_id: null, post_message_id: null } as PurchaseRow;

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
