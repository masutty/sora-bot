import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { encrypt } from "@/utils/crypto";
import { Logger } from "@/utils/logging";
import { addCategory, getEnabledCategories, getOrCreateGuildConfig, isGuildReady } from "./repository/guilds";
import { createMacroChannel, deleteUserCascade, ensureUser, getMacroChannelByUserId, registerChannel } from "./repository/users";
import { BiomeHuntError } from "./types";
import type { GuildConfigRow } from "./types";

const logger = new Logger("biomehunt.guildSetup");

export interface SetupResult {
    channelId: string;
    webhookUrl: string;
}

export async function runUserSetup(guild: Guild, member: GuildMember): Promise<SetupResult> {
    const { ready } = await isGuildReady(guild.id);
    if (!ready) {
        throw new BiomeHuntError("It seems that this server is not fully configured yet! Please contact an administrator for more information.");
    }

    const user = await ensureUser(guild.id, member.id);
    const existingChannel = await getMacroChannelByUserId(user.id);
    if (existingChannel) {
        throw new BiomeHuntError("It seems that you already have a macro channel set up. Ask an administrator to reset it if you need to regenerate it.");
    }

    const guildConfig = await getOrCreateGuildConfig(guild.id);
    const category = await findOrCreateCategory(guild, guildConfig);

    const safeName = member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
    const channel = await guild.channels.create({
        name: `・${safeName}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
        ],
    });

    let webhook;
    try {
        webhook = await channel.createWebhook({ name: "BiomeHunt Tracker" });
    } catch (err) {
        await channel.delete().catch(() => {});
        logger.error(err instanceof Error ? err : new Error(String(err)));
        throw new BiomeHuntError("Failed to create a webhook for your channel. Please try again.");
    }

    try {
        await createMacroChannel(user.id, channel.id, webhook.id, encrypt(webhook.url));
    } catch (err) {
        await webhook.delete().catch(() => {});
        await channel.delete().catch(() => {});
        throw err;
    }

    try {
        await member.send(
            `Here is your webhook for <#${channel.id}>:` +
            `\n${webhook.url}\n\n` +
            "-# Do not share this URL with anyone, nor use it for anything other than your macro.\n" +
            "-# You can be punished for webhook misuse. If you believe that your webhook url has leaked, please contact an administrator as soon as possible.\n",
        );
    } catch {
        await deleteUserCascade(user.id);
        await webhook.delete().catch(() => {});
        await channel.delete().catch(() => {});
        throw new BiomeHuntError("I couldn't send you a DM. Please enable direct messages from server members and try `/bh setup` again.");
    }

    registerChannel(channel.id, { userId: user.id, guildId: guild.id, webhookId: webhook.id });
    return { channelId: channel.id, webhookUrl: webhook.url };
}

async function findOrCreateCategory(guild: Guild, guildConfig: GuildConfigRow) {
    const enabled = await getEnabledCategories(guild.id);

    for (const cat of enabled) {
        const discordCategory = guild.channels.cache.get(cat.discord_category_id);
        if (discordCategory?.type === ChannelType.GuildCategory && discordCategory.children.cache.size < 50) {
            return discordCategory;
        }
    }

    if (!guildConfig.auto_create_categories) {
        throw new BiomeHuntError("There's no space available for a new macro channel right now. Please contact an administrator.");
    }

    const newCategory = await guild.channels.create({ name: "BiomeHunt Macros", type: ChannelType.GuildCategory });
    await addCategory(guild.id, newCategory.id);
    return newCategory;
}
