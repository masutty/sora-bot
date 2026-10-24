import { ChannelType, type Client, type GuildTextBasedChannel } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { isFlagEnabled } from "../repository/flags.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import {
    buyItem,
    getPurchaseByCode,
    markDelivered,
    refundPurchase,
    refundWouldRemoveRole,
    setPurchasePost,
} from "../repository/purchases.repository";
import { getItem, getShop } from "../repository/shop.repository";
import type { PurchaseRow } from "../types";
import { buildSalePost } from "../views/shop-purchase.view";
import { describeDiscordError, guildLog } from "./guild-log.service";
import type { ShopDeps } from "./shop.service";

const UNKNOWN_MEMBER = 10007;

async function fetchMember(client: Client, guildId: string, userId: string) {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
    return guild.members.fetch(userId);
}

async function fetchTextChannel(client: Client, channelId: string): Promise<GuildTextBasedChannel> {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
        throw new Error(`Channel ${channelId} isn't a text channel`);
    }
    return channel;
}

/** The sale post's database lookups, injectable so tests need no DB. */
export interface SalesIo {
    salesChannelId(guildId: string): Promise<string | null>;
    logChannelId(guildId: string): Promise<string | null>;
    savePost(purchaseId: number, channelId: string, messageId: string): Promise<void>;
    /** Replaces the guild log, for tests. */
    log?: ShopDeps["log"];
}

const defaultSalesIo: SalesIo = {
    salesChannelId: async (guildId) => (await getShop(guildId))?.sales_channel_id ?? null,
    logChannelId: async (guildId) => (await getOrCreateGuildConfig(guildId)).log_channel_id,
    savePost: setPurchasePost,
};

/**
 * The real wiring of the shop flows. Sale-post failures are logged here (one warning per server,
 * dedup key `shop-sales`) and never thrown, so the flows' own log-on-throw doesn't repeat them.
 * Lives apart from `shop.service.ts` because the sale post view imports the flows from there.
 */
export function defaultShopDeps(client: BotClient, io: SalesIo = defaultSalesIo): ShopDeps {
    const log: ShopDeps["log"] = io.log ?? ((guildId, entry) => guildLog(client, guildId, entry));

    const warnSales = (title: string, purchase: PurchaseRow, channelId: string | null, err: unknown) =>
        log(purchase.guild_id, {
            kind: "warning",
            title,
            body: `Purchase \`${purchase.code}\`${channelId ? ` in <#${channelId}>` : ""} - ${describeDiscordError(err)}.`,
            dedupKey: "shop-sales",
        });

    return {
        now: () => new Date(),
        random: Math.random,
        economyOn: (guildId) => isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"),
        getShop,
        getItem,
        buyItem,
        refundPurchase,
        markDelivered,
        getPurchaseByCode,
        refundWouldRemoveRole,
        log,

        async addRole(guildId, discordUserId, roleId) {
            const member = await fetchMember(client, guildId, discordUserId);
            await member.roles.add(roleId);
        },
        async removeRole(guildId, discordUserId, roleId) {
            try {
                const member = await fetchMember(client, guildId, discordUserId);
                await member.roles.remove(roleId);
            } catch (err) {
                // Someone who left has no role left to take.
                if ((err as { code?: number } | null)?.code !== UNKNOWN_MEMBER) throw err;
            }
        },

        async postSale(purchase) {
            let channelId: string | null = null;
            try {
                channelId = (await io.salesChannelId(purchase.guild_id)) ?? (await io.logChannelId(purchase.guild_id));
                if (!channelId) return;
                const channel = await fetchTextChannel(client, channelId);
                const message = await channel.send(buildSalePost(purchase));
                await io.savePost(purchase.id, channel.id, message.id);
            } catch (err) {
                await warnSales("⚠️ Couldn't post a shop sale", purchase, channelId, err);
            }
        },
        async updateSalePost(purchase) {
            if (!purchase.post_channel_id || !purchase.post_message_id) return;
            try {
                const channel = await fetchTextChannel(client, purchase.post_channel_id);
                await channel.messages.edit(purchase.post_message_id, buildSalePost(purchase));
            } catch (err) {
                await warnSales("⚠️ Couldn't update a shop sale", purchase, purchase.post_channel_id, err);
            }
        },
    };
}
