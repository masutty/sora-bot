import { EmbedBuilder } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { EmbedFormatter } from "@/utils/format";
import { runUserSetup } from "../guildSetup";
import { getGuildBadgeRole, grantUserBadge, revokeUserBadge } from "../repository/badges";
import { enqueueRoleJob } from "../repository/roleJobs";
import { deleteUserCascade, getUserByDiscordId, pauseUser, unpauseUser } from "../repository/users";
import { BADGE_META, BiomeHuntError, type Badge } from "../types";
import { buildGuildStatsEmbed, buildLeaderboardEmbed, buildProfileEmbed, getQuotaRewardLines } from "./profileViews";

export async function checkUserAction(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    return buildProfileEmbed(guildId, member);
}

export async function resetUserAction(guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data to reset.");
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

export async function quotaProgressAction(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const lines = await getQuotaRewardLines(guildId, user.id);
    if (lines.length === 0) return EmbedFormatter.info("No quota roles configured for this server.");

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`\`${member.user.username}\`'s Quota Progress`)
        .setThumbnail(member.displayAvatarURL())
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: "F: Fixed, RW: Rolling Window" });
}

export async function addBadgeAction(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const granted = await grantUserBadge(user.id, badge);
    if (!granted) return `<@${discordUserId}> already has the ${BADGE_META[badge].label} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "add");

    return `${BADGE_META[badge].emoji} <@${discordUserId}> was granted the ${BADGE_META[badge].label} badge.`;
}

export async function removeBadgeAction(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const revoked = await revokeUserBadge(user.id, badge);
    if (!revoked) return `<@${discordUserId}> doesn't have the ${BADGE_META[badge].label} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "remove");

    return `${BADGE_META[badge].label} badge removed from <@${discordUserId}>.`;
}

export async function guildStatsAction(guildId: string): Promise<EmbedBuilder> {
    return buildGuildStatsEmbed(guildId);
}

export async function leaderboardAction(guildId: string): Promise<EmbedBuilder> {
    return buildLeaderboardEmbed(guildId);
}
