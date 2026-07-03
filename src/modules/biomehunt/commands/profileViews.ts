import { EmbedBuilder, GuildMember } from "discord.js";
import { EmbedFormatter, formatCodeblock, formatTime } from "@/utils/format";
import { getOrCreateGuildConfig } from "../repository/guilds";
import {
    getActiveSecondsInWindow, getBiomeCounts, getComplianceRate, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getGuildUserCounts, getUserByDiscordId } from "../repository/users";
import { Logger } from "@/utils/logging";

const logger = new Logger("biomehunt:profileViews");

const STATUS_EMOJI = { active: "🟢", idle: "🟡", inactive: "🔴" } as const;

export async function buildProfileEmbed(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) return EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.");

    logger.debug(`Found user: ${JSON.stringify(user, null, 2)}`);

    const guildConfig = await getOrCreateGuildConfig(guildId);
    const activeSeconds = await getActiveSecondsInWindow(user.id, guildConfig.quota_window_hours);
    const compliant = activeSeconds >= guildConfig.quota_target_seconds;
    const biomes = await getBiomeCounts(user.id);

    const embed = new EmbedBuilder()
        .setColor(compliant ? 0x57f287 : 0xed4245)
        .setTitle(`\`${member.user.username}\`'s hunter profile`)
        .setThumbnail(member.displayAvatarURL())
        .setDescription([
            `- \`${formatTime(activeSeconds)}\` activity time in the last \`${guildConfig.quota_window_hours}h\` window.`,
            `- \`${biomes.length}\` biomes registered.`,
        ].join("\n"))
        .setFooter({ text: `profile created at <t:${Math.floor(user.created_at.getTime() / 1000)}:R>` })
        .addFields(
            {
                name: "Current Status",
                value: formatCodeblock(STATUS_EMOJI[user.current_status] + " " + user.current_status.toUpperCase()),
                inline: true
            },
            {
                name: `Quota (last ${guildConfig.quota_window_hours}h)`,
                value: formatCodeblock(`${compliant ? "✅" : "❌"}`),
                inline: true,
            },
        );

    if (biomes.length > 0) {
        embed.addFields({ name: "Biomes registered:", value: formatCodeblock(biomes.map((b) => `${b.biome}: ${b.count}`).join("\n")) });
    }

    return embed;
}

export async function buildHistoryEmbed(guildId: string, discordUserId: string): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.");

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
