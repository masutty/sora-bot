import { type Guild, PermissionFlagsBits } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { countPending, countPendingForItem } from "../repository/purchases.repository";
import {
    ensureShop,
    insertItem,
    listLiveItems,
    moveItem,
    removeItem,
    setSalesChannel,
    setShopOpen,
    updateItem,
} from "../repository/shop.repository";
import type { ShopAdminDeps } from "../views/shop-admin.view";
import { roleProblem } from "./shop.service";
import { defaultShopDeps } from "./shop-deps.service";

/**
 * The real wiring of `/admin shop`. Lives apart from the view so a test that imports the view
 * never loads the real repositories.
 */
export function defaultShopAdminDeps(client: BotClient, guild: Guild): ShopAdminDeps {
    const shop = defaultShopDeps(client);
    return {
        guildId: guild.id,
        shop,
        ensureShop,
        listLiveItems,
        insertItem,
        updateItem,
        removeItem,
        moveItem,
        setShopOpen,
        setSalesChannel,
        countPending,
        countPendingForItem,
        economyOn: (guildId) => shop.economyOn(guildId),
        checkRole: async (guildId, roleId) => {
            const me = guild.members.me ?? (await guild.members.fetchMe());
            const role = await guild.roles.fetch(roleId).catch(() => null);
            return roleProblem(role, guildId, me.roles.highest.position, me.permissions.has(PermissionFlagsBits.ManageRoles));
        },
    };
}
