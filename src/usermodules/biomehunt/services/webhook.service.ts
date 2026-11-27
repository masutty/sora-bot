import { ChannelType, type Client, type TextChannel } from "discord.js";
import { decrypt, encrypt } from "@/utils/crypto";
import { Logger } from "@/utils/logging";
import { isFlagEnabled } from "../repository/flags.repository";
import {
    claimWebhookRegeneration,
    getMacroChannelByUserId,
    getUserByDiscordId,
    getUserById,
    registerChannel,
    replaceMacroWebhook,
    setWebhookRegeneratedAt,
} from "../repository/users.repository";
import { settings } from "../settings";
import { BiomeHuntError, type UserRow } from "../types";
import { ensureFlower } from "./flower.service";

const logger = new Logger("biomehunt.services.webhook");

export interface MemberWebhook {
    userId: number;
    channelId: string;
    url: string;
    /** When it can be regenerated again - `null` when it can right now. */
    nextRegenerationAt: Date | null;
}

export interface WebhookDeps {
    getUserByDiscordId: typeof getUserByDiscordId;
    getUserById: typeof getUserById;
    getMacroChannelByUserId: typeof getMacroChannelByUserId;
    claimWebhookRegeneration: typeof claimWebhookRegeneration;
    setWebhookRegeneratedAt: typeof setWebhookRegeneratedAt;
    replaceMacroWebhook: typeof replaceMacroWebhook;
    registerChannel: typeof registerChannel;
    /** Creates the new webhook in the macro channel, dressed like the member's Flower where the server uses them. */
    createWebhook(channelId: string, user: UserRow): Promise<{ id: string; url: string }>;
    /** Resolves `false` when the webhook is still there. */
    deleteWebhook(webhookId: string): Promise<boolean>;
    encrypt(text: string): string;
    decrypt(text: string): string;
}

const UNKNOWN_WEBHOOK = 10015;

export function defaultWebhookDeps(client: Client): WebhookDeps {
    return {
        getUserByDiscordId,
        getUserById,
        getMacroChannelByUserId,
        claimWebhookRegeneration,
        setWebhookRegeneratedAt,
        replaceMacroWebhook,
        registerChannel,
        createWebhook: async (channelId, user) => {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) throw new BiomeHuntError("I can't access your macro channel.");
            const webhook = await (channel as TextChannel).createWebhook({ name: "Biome Hunt Tracker" }).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
                throw new BiomeHuntError("I couldn't create a webhook in your channel. Ask the staff to check my permissions.");
            });
            if (user.flower && (await isFlagEnabled(user.guild_id, "EXPERIMENT_WEBHOOK_FLOWERS"))) {
                await ensureFlower(webhook, user.flower, logger);
            }
            return { id: webhook.id, url: webhook.url };
        },
        deleteWebhook: async (webhookId) => {
            try {
                await (await client.fetchWebhook(webhookId)).delete();
                return true;
            } catch (err) {
                if ((err as { code?: number }).code === UNKNOWN_WEBHOOK) return true;
                logger.error(err instanceof Error ? err : new Error(String(err)), { webhookId });
                return false;
            }
        },
        encrypt,
        decrypt,
    };
}

function nextRegeneration(last: Date | null, now = Date.now()): Date | null {
    if (!last) return null;
    const next = last.getTime() + settings.webhook.regenerationCooldownS * 1000;
    return next > now ? new Date(next) : null;
}

/** The webhook of a member's own macro channel in this server. */
export async function getMemberWebhook(guildId: string, discordUserId: string, deps: WebhookDeps): Promise<MemberWebhook> {
    const user = await deps.getUserByDiscordId(guildId, discordUserId);
    const channel = user ? await deps.getMacroChannelByUserId(user.id) : null;
    if (!user || !channel) throw new BiomeHuntError("You don't have a macro channel yet. Run `/bh setup` to get one.");
    return {
        userId: user.id,
        channelId: channel.channel_id,
        url: deps.decrypt(channel.webhook_url),
        nextRegenerationAt: nextRegeneration(user.webhook_regenerated_at),
    };
}

/**
 * Replaces a member's webhook with a new one, once per cooldown. Only the channel's owner may. The
 * old URL stops counting as soon as the new webhook is saved; `oldRemoved` is `false` when Discord
 * refused to delete it, so it can still post in the channel.
 */
export async function regenerateWebhook(
    userId: number,
    requesterDiscordId: string,
    deps: WebhookDeps,
): Promise<MemberWebhook & { oldRemoved: boolean }> {
    const user = await deps.getUserById(userId);
    if (!user || user.discord_user_id !== requesterDiscordId) throw new BiomeHuntError("This webhook isn't yours.");
    const channel = await deps.getMacroChannelByUserId(userId);
    if (!channel) throw new BiomeHuntError("You don't have a macro channel anymore. Run `/bh setup` to get one.");

    const claim = await deps.claimWebhookRegeneration(userId, settings.webhook.regenerationCooldownS);
    if (!claim) throw new BiomeHuntError("You already regenerated your webhook in the last 24 hours.");

    let webhook: { id: string; url: string } | null = null;
    try {
        webhook = await deps.createWebhook(channel.channel_id, user);
        await deps.replaceMacroWebhook(userId, webhook.id, deps.encrypt(webhook.url));
    } catch (err) {
        // Nothing changed for the member, so the attempt doesn't count.
        if (webhook) await deps.deleteWebhook(webhook.id);
        await deps.setWebhookRegeneratedAt(userId, claim.previous);
        throw err;
    }

    deps.registerChannel(channel.channel_id, { userId, guildId: user.guild_id, webhookId: webhook.id });
    const oldRemoved = await deps.deleteWebhook(channel.webhook_id);
    logger.info(`Regenerated the webhook of user ${userId} (guild ${user.guild_id}), old one removed: ${oldRemoved}`);

    return {
        userId,
        channelId: channel.channel_id,
        url: webhook.url,
        nextRegenerationAt: nextRegeneration(new Date()),
        oldRemoved,
    };
}
