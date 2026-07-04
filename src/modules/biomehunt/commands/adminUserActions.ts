import { EmbedBuilder } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { EmbedFormatter, formatTime, unix } from "@/utils/format";
import { runUserSetup } from "../guildSetup";
import { getActiveSecondsInWindow } from "../repository/activity";
import { getUserQuotaProgress } from "../repository/quotaRoles";
import { deleteUserCascade, getUserByDiscordId, pauseUser, unpauseUser } from "../repository/users";
import { BiomeHuntError } from "../types";
import { buildGuildStatsEmbed, buildLeaderboardEmbed, buildProfileEmbed } from "./profileViews";

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

export async function quotaProgressAction(guildId: string, discordUserId: string): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const progress = await getUserQuotaProgress(guildId, user.id);
    if (progress.length === 0) return EmbedFormatter.info("No quota roles configured for this server.");

    const lines = await Promise.all(progress.map(async (p) => {
        const activeSeconds = await getActiveSecondsInWindow(user.id, p.quota_window_hours);
        const modeLabel = p.mode === "F" ? "Fixed" : "Rolling Window";
        const progressText = `${formatTime(activeSeconds)} / ${formatTime(p.quota_target_seconds)}`;

        let statusText: string;
        if (p.held_granted_at) {
            statusText = p.mode === "F" && p.held_expires_at
                ? `holds it, expires <t:${unix(p.held_expires_at)}:R>`
                : "holds it";
        } else if (activeSeconds >= p.quota_target_seconds) {
            statusText = p.mode === "F" ? "qualifies — granted at the next daily evaluation" : "qualifies — syncs within ~30s";
        } else {
            statusText = "not yet qualified";
        }

        return `<@&${p.role_id}> (${modeLabel}) — ${progressText} — ${statusText}`;
    }));

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`<@${discordUserId}>'s Quota Progress`)
        .setDescription(lines.join("\n"));
}

export async function guildStatsAction(guildId: string): Promise<EmbedBuilder> {
    return buildGuildStatsEmbed(guildId);
}

export async function leaderboardAction(guildId: string): Promise<EmbedBuilder> {
    return buildLeaderboardEmbed(guildId);
}
