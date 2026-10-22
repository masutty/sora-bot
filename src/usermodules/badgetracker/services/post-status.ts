import { type Client, type Guild, PermissionFlagsBits } from "discord.js";

export type PostStatus = "ok" | "no_channel" | "not_in_guild" | "channel_missing" | "no_permission";

/** Whether the bot can post in a subscription's channel right now. */
export function postStatus(client: Client, guildId: string, channelId: string | null): PostStatus {
    if (!channelId) return "no_channel";
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) return "not_in_guild";
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return "channel_missing";
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) return "no_permission";
    return "ok";
}

/** Whether a post can ping the role: it is mentionable, or the bot may mention everyone. */
export function canMention(guild: Guild, roleId: string): boolean {
    if (guild.roles.cache.get(roleId)?.mentionable) return true;
    return guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone) ?? false;
}

export function roleExists(client: Client, guildId: string, roleId: string): boolean {
    return client.guilds.cache.get(guildId)?.roles.cache.has(roleId) ?? false;
}
