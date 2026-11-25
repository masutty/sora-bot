import { ChannelType, type GuildBasedChannel, type GuildMember, PermissionFlagsBits } from "discord.js";

export type ChannelAccess = "ok" | "not_text" | "user_cannot_manage" | "bot_missing_perms";

const BOT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ReadMessageHistory,
];

/** Text and announcement channels only; the member needs ManageMessages there and the bot needs the posting permissions. */
export function channelAccess(channel: GuildBasedChannel, member: GuildMember, me: GuildMember): ChannelAccess {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return "not_text";
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages)) return "user_cannot_manage";
    if (!channel.permissionsFor(me)?.has(BOT_PERMISSIONS)) return "bot_missing_perms";
    return "ok";
}

export const accessMessage: Record<Exclude<ChannelAccess, "ok">, (channelId: string) => string> = {
    not_text: (id) => `<#${id}> is not a text channel.`,
    user_cannot_manage: (id) => `You need Manage Messages in <#${id}>.`,
    bot_missing_perms: (id) => `I need View Channel, Send Messages, Manage Messages and Read Message History in <#${id}>.`,
};
