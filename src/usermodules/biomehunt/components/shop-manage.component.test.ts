import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { createFakeViewTransport } from "@/define";
import type { ShopDeps } from "../services/shop.service";
import type { PurchaseRow } from "../types";
import { shopManageComponent } from "./shop-manage.component";

const client = {} as BotClient;

function fakeInteraction(isAdmin: boolean, onEdit: (payload: unknown) => void = () => {}) {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const deferred: unknown[] = [];
    const interaction = {
        isButton: () => true,
        guildId: "g1",
        user: { id: "a1" },
        memberPermissions: { has: () => isAdmin },
        reply: async (p: unknown) => void replies.push(p),
        deferReply: async (p: unknown) => void deferred.push(p),
        editReply: async (p: unknown) => {
            edits.push(p);
            onEdit(p);
            return {};
        },
        webhook: { editMessage: async () => ({}) },
    };
    return { interaction, replies, edits, deferred };
}

function fakeDeps(found: Partial<PurchaseRow> | null) {
    const looked: string[] = [];
    const deps = {
        getPurchaseByCode: async (_g: string, code: string) => {
            looked.push(code);
            return found;
        },
    } as unknown as ShopDeps;
    return { deps, looked };
}

test("a non-admin is told so and the purchase is never read", async () => {
    const { interaction, replies, deferred } = fakeInteraction(false);
    const { deps, looked } = fakeDeps(null);
    await shopManageComponent(deps).handle(interaction as never, ["K7Q2MX"], client);
    expect(replies).toEqual([{ content: "Only admins can manage purchases.", flags: MessageFlags.Ephemeral }]);
    expect(deferred).toEqual([]);
    expect(looked).toEqual([]);
});

test("an unknown code gets an ephemeral not-found", async () => {
    const { interaction, edits, deferred } = fakeInteraction(true);
    const { deps, looked } = fakeDeps(null);
    await shopManageComponent(deps).handle(interaction as never, ["K7Q2MX"], client);
    expect(deferred).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(looked).toEqual(["K7Q2MX"]);
    expect(edits).toEqual([{ content: "This purchase no longer exists." }]);
});

test("an admin gets the purchase card, without Back", async () => {
    const { deps } = fakeDeps({
        code: "K7Q2MX",
        guild_id: "g1",
        status: "pending",
        kind: "manual",
        item_name: "Sticker",
        item_emoji: null,
        price: 5,
        buyer_discord_id: "u1",
        created_at: new Date(),
    });
    const { interaction, edits } = fakeInteraction(true);
    const fake = createFakeViewTransport();
    // runView sends the first render through editReply; the fake transport is bound to that message.
    void shopManageComponent(deps, () => fake).handle(interaction as never, ["K7Q2MX"], client);
    await fake.flush();
    expect(edits).toHaveLength(1);
    const json = JSON.stringify((edits[0] as { components: { toJSON(): unknown }[] }).components.map((c) => c.toJSON()));
    expect(json).toContain("Mark delivered");
    expect(json).toContain("Refund");
    expect(json).not.toContain("Back");
});
