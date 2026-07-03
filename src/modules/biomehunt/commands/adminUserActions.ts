import { EmbedBuilder } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { runUserSetup } from "../guildSetup";
import { deleteUserCascade, getUserByDiscordId, pauseUser, unpauseUser } from "../repository/users";
import { BiomeHuntError } from "../types";
import { buildGuildStatsEmbed, buildLeaderboardEmbed, buildProfileEmbed } from "./profileViews";

export async function checkUserAction(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    return buildProfileEmbed(guildId, member);
}

export async function resetUserAction(guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no BiomeHunt data to reset.");
    await deleteUserCascade(user.id);
    return `<@${discordUserId}>'s data has been reset. They can run \`/bh setup\` again.`;
}

export async function removeUserAction(guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data to remove.");
    await deleteUserCascade(user.id);
    return `<@${discordUserId}> has been removed from the hunt.`;
}

export async function pauseUserAction(guildId: string, discordUserId: string): Promise<string> {
    const paused = await pauseUser(guildId, discordUserId);
    if (!paused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is now exempt from inactivity auto-delete.`;
}

export async function unpauseUserAction(guildId: string, discordUserId: string): Promise<string> {
    const unpaused = await unpauseUser(guildId, discordUserId);
    if (!unpaused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is no longer exempt from inactivity auto-delete.`;
}

export async function setupUserAction(guild: Guild, member: GuildMember): Promise<string> {
    const result = await runUserSetup(guild, member);
    return `Setup complete for <@${member.id}>. Their webhook URL was sent to their DMs. Channel: <#${result.channelId}>`;
}

export async function guildStatsAction(guildId: string): Promise<EmbedBuilder> {
    return buildGuildStatsEmbed(guildId);
}

export async function leaderboardAction(guildId: string): Promise<EmbedBuilder> {
    return buildLeaderboardEmbed(guildId);
}
