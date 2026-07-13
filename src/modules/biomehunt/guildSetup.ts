import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { CategoryChannel, Guild, GuildMember, OverwriteResolvable, TextChannel } from "discord.js";
import { encrypt } from "@/utils/crypto";
import { Logger } from "@/utils/logging";
import { addCategory, getEnabledCategories, getOrCreateGuildConfig, isGuildReady } from "./repository/guilds";
import {
    createMacroChannel, deleteUserCascade, ensureUser, getMacroChannelByUserId, lookupChannel, registerChannel,
} from "./repository/users";
import { BiomeHuntError } from "./types";
import type { GuildConfigRow } from "./types";

const logger = new Logger("biomehunt.guildSetup");

export interface SetupResult {
    channelId: string;
    webhookUrl: string;
}

/** The bot's macro channel naming convention - shared by fresh setup and admin-adopted existing channels. */
export function macroChannelName(username: string): string {
    return `・${username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80)}`;
}

export async function runUserSetup(guild: Guild, member: GuildMember, opts: { dmUser?: boolean } = {}): Promise<SetupResult> {
    const dmUser = opts.dmUser ?? true;

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

    const channel = await guild.channels.create({
        name: macroChannelName(member.user.username),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: buildMacroChannelOverwrites(category, member),
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

    if (dmUser) {
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
    }

    registerChannel(channel.id, { userId: user.id, guildId: guild.id, webhookId: webhook.id });
    return { channelId: channel.id, webhookUrl: webhook.url };
}

/**
 * Registers a channel + webhook that already exist (created outside the bot, e.g. by a macro
 * tool before the member was ever tracked) as a member's macro channel, instead of creating a
 * fresh one. Discord only exposes a webhook's token/URL to whoever created it, so there's no way
 * for the bot to look this up itself - the caller must supply the exact URL, which is validated
 * against the channel's actual webhooks before anything is renamed or registered.
 *
 * The caller is expected to have already cleared any prior registration for this member (see
 * `memberForceSetupAction`) - this function does not check for or remove an existing channel.
 */
export async function adoptExistingChannel(
    guild: Guild,
    member: GuildMember,
    channel: TextChannel,
    webhookUrl: string,
): Promise<SetupResult> {
    const { ready } = await isGuildReady(guild.id);
    if (!ready) {
        throw new BiomeHuntError("This server isn't fully configured yet - set up categories and status roles first.");
    }

    const user = await ensureUser(guild.id, member.id);

    if (lookupChannel(channel.id)) {
        throw new BiomeHuntError("That channel is already registered to a different member.");
    }

    const webhookId = parseWebhookId(webhookUrl);
    if (!webhookId) {
        throw new BiomeHuntError("That doesn't look like a valid Discord webhook URL.");
    }

    const webhooks = await channel.fetchWebhooks().catch(() => null);
    if (!webhooks?.has(webhookId)) {
        throw new BiomeHuntError("That webhook wasn't found on the given channel - double check the URL and channel.");
    }

    try {
        await channel.setName(macroChannelName(member.user.username));
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)));
        throw new BiomeHuntError("Failed to rename the channel - check my permissions there and try again.");
    }

    await createMacroChannel(user.id, channel.id, webhookId, encrypt(webhookUrl));
    registerChannel(channel.id, { userId: user.id, guildId: guild.id, webhookId });

    return { channelId: channel.id, webhookUrl };
}

function parseWebhookId(url: string): string | null {
    return url.match(/\/webhooks\/(\d+)\//)?.[1] ?? null;
}

/**
 * Clones the category's own permission overwrites onto the new macro channel - so admins
 * control macro channel visibility entirely by configuring the category, the same way any
 * other Discord channel under it works - then layers the owner's access on top. Discord
 * doesn't auto-sync a freshly created channel to its parent's permissions (that only happens
 * via the "Sync Permissions" UI action), so this has to be done explicitly.
 */
function buildMacroChannelOverwrites(category: CategoryChannel, member: GuildMember): OverwriteResolvable[] {
    const cloned: OverwriteResolvable[] = category.permissionOverwrites.cache
        .filter((overwrite) => overwrite.id !== member.id)
        .map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield }));

    return [
        ...cloned,
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
    ];
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
