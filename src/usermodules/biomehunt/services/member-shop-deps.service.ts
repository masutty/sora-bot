import type { Guild, GuildMember } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { countMemberItemPurchases, getActiveGrantEnd, listMemberPurchases } from "../repository/purchases.repository";
import { getItem, getShop, listLiveItems } from "../repository/shop.repository";
import { getUserByDiscordId } from "../repository/users.repository";
import type { MemberShopDeps } from "../views/shop.view";
import { purchaseItem } from "./shop.service";
import { defaultShopDeps } from "./shop-deps.service";

/**
 * The real wiring of `/bh shop`. Lives apart from the view so a test that imports the view
 * never loads the real repositories.
 */
export function defaultMemberShopDeps(client: BotClient, guild: Guild, member: GuildMember): MemberShopDeps {
    const shop = defaultShopDeps(client);
    return {
        now: shop.now,
        economyOn: (guildId) => shop.economyOn(guildId),
        getShop,
        listLiveItems,
        getItem,
        getSeeds: async () => (await getUserByDiscordId(guild.id, member.id))?.seeds ?? null,
        listMemberPurchases,
        countMemberItemPurchases,
        getActiveGrantEnd,
        // The gateway keeps the cached member's roles current; fall back to the one the interaction carried.
        holdsRole: (roleId) => (guild.members.cache.get(member.id) ?? member).roles.cache.has(roleId),
        purchaseItem: (input) => purchaseItem(shop, input),
    };
}
