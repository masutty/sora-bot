import { EmbedBuilder } from "discord.js";
import { EmbedFormatter, formatTime } from "@/utils/format";
import { getOrCreateGuildConfig } from "../repository/guilds";
import {
    getActiveSecondsInWindow, getBiomeCounts, getComplianceRate, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getGuildUserCounts, getUserByDiscordId } from "../repository/users";

const STATUS_EMOJI = { active: "🟢", idle: "🟡", inactive: "🔴" } as const;

export async function buildProfileEmbed(guildId: string, discordUserId: string): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return EmbedFormatter.info("You haven't set up BiomeHunt yet. Run `/bh setup` to get started.");

    const guildConfig = await getOrCreateGuildConfig(guildId);
    const activeSeconds = await getActiveSecondsInWindow(user.id, guildConfig.quota_window_hours);
    const compliant = activeSeconds >= guildConfig.quota_target_seconds;
    const biomes = await getBiomeCounts(user.id);

    const embed = new EmbedBuilder()
        .setColor(compliant ? 0x57f287 : 0xed4245)
        .setTitle("BiomeHunt Profile")
        .addFields(
            { name: "Status", value: `${STATUS_EMOJI[user.current_status]} ${user.current_status.toUpperCase()}`, inline: true },
            {
                name: `Quota (last ${guildConfig.quota_window_hours}h)`,
                value: `${formatTime(activeSeconds)} / ${formatTime(guildConfig.quota_target_seconds)} — ${compliant ? "✅ Compliant" : "❌ Not compliant"}`,
            },
        );

    if (biomes.length > 0) {
        embed.addFields({ name: "Biomes captured", value: biomes.map((b) => `${b.biome}: ${b.count}`).join("\n") });
    }

    return embed;
}

export async function buildHistoryEmbed(guildId: string, discordUserId: string): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return EmbedFormatter.info("You haven't set up BiomeHunt yet. Run `/bh setup` to get started.");

    const sessions = await getRecentSessions(user.id, 10);
    if (sessions.length === 0) return EmbedFormatter.info("No activity recorded yet.");

    const brokenCount = Math.max(sessions.length - 1, 0);
    const lines = sessions.map((s) => `<t:${Math.floor(s.started_at.getTime() / 1000)}:R> — ${formatTime(s.duration_seconds)}`);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Session History")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${brokenCount} session gap(s) in this history` });
}

export async function buildLeaderboardEmbed(guildId: string): Promise<EmbedBuilder> {
    const guildConfig = await getOrCreateGuildConfig(guildId);
    const rows = await getLeaderboard(guildId, guildConfig.quota_window_hours, 10);
    if (rows.length === 0) return EmbedFormatter.info("No activity recorded yet.");

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.discordUserId}> — ${formatTime(r.activeSeconds)} (${r.sessionCount} sessions)`);

    return new EmbedBuilder().setColor(0x5865f2).setTitle("BiomeHunt Leaderboard").setDescription(lines.join("\n"));
}

export async function buildGuildStatsEmbed(guildId: string): Promise<EmbedBuilder> {
    const guildConfig = await getOrCreateGuildConfig(guildId);
    const counts = await getGuildUserCounts(guildId);
    const { compliant, total } = await getComplianceRate(guildId, guildConfig.quota_window_hours, guildConfig.quota_target_seconds);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Guild Stats")
        .addFields(
            { name: "🟢 Active", value: String(counts.active), inline: true },
            { name: "🟡 Idle", value: String(counts.idle), inline: true },
            { name: "🔴 Inactive", value: String(counts.inactive), inline: true },
            { name: "Quota compliance", value: total > 0 ? `${compliant} / ${total} users` : "No users tracked yet" },
        );
}
