import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GuildMember } from "discord.js";
import { EmbedFormatter, formatCodeblock, formatTime, unix } from "@/utils/format";
import { getOrCreateGuildConfig } from "../repository/guilds";
import {
    getActiveSecondsInWindow, getBiomeCounts, getComplianceRate, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getGuildUserCounts, getMacroChannelByUserId, getUserByDiscordId, getUsersByGuildStatus } from "../repository/users";
import type { ActivitySessionRow, ActivityStatus, UserRow } from "../types";
import { Logger } from "@/utils/logging";

const logger = new Logger("biomehunt.profileViews");

export const SESSIONS_PER_PAGE = 10;
export const USERS_PER_PAGE = 10;

const STATUS_EMOJI = { active: "🟢", idle: "🟡", inactive: "🔴" } as const;

export async function buildProfileEmbed(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) return EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.");

    // logger.debug(`Found user: ${JSON.stringify(user, null, 2)}`);

    const guildConfig = await getOrCreateGuildConfig(guildId);
    const activeSeconds = await getActiveSecondsInWindow(user.id, guildConfig.quota_window_hours);
    const compliant = activeSeconds >= guildConfig.quota_target_seconds;
    const biomes = await getBiomeCounts(user.id);
    const channel = await getMacroChannelByUserId(user.id);

    const embed = new EmbedBuilder()
        .setColor(compliant ? 0x57f287 : 0xed4245)
        .setTitle(`\`${member.user.username}\`'s hunter profile`)
        .setThumbnail(member.displayAvatarURL())
        .setDescription([
            `- \`${formatTime(activeSeconds)}\` activity time in the last \`${guildConfig.quota_window_hours}h\` window.`,
            `- \`${biomes.length}\` biomes registered.`,
            `- Profile created <t:${Math.floor(user.created_at.getTime() / 1000)}:R>`,
        ].join("\n"))
        .addFields(
            {
                name: "Macro Channel",
                value: `${channel ? `<#${channel.channel_id}>` : formatCodeblock("No channel.")}`,
                inline: false,
            },
            {
                name: "Current Status",
                value: formatCodeblock(STATUS_EMOJI[user.current_status] + " " + user.current_status.toUpperCase()),
                inline: true
            },
            {
                name: `Quota (last ${guildConfig.quota_window_hours}h)`,
                value: formatCodeblock(`${compliant ? "✅" : "❌ ( " + formatTime(activeSeconds) + " / " + formatTime(guildConfig.quota_target_seconds) + " )"}`),
                inline: true,
            },
        );

    if (biomes.length > 0) {
        embed.addFields({ name: "Biomes registered:", value: formatCodeblock(biomes.map((b) => `${b.biome}: ${b.count}`).join("\n")) });
    }

    return embed;
}

export async function getSessionHistory(guildId: string, discordUserId: string, limit = 100): Promise<ActivitySessionRow[] | null> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;
    return getRecentSessions(user.id, limit);
}

export function buildHistoryEmbed(sessions: ActivitySessionRow[], member: GuildMember, page: number): EmbedBuilder {
    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    const start = page * SESSIONS_PER_PAGE;
    const slice = sessions.slice(start, start + SESSIONS_PER_PAGE);
    const oldestFirst = [...slice].reverse();

    const lines: string[] = [];
    oldestFirst.forEach((session, i) => {
        lines.push(
            `<t:${unix(session.started_at)}:F> - <t:${unix(session.ended_at)}:F> (${formatTime(session.duration_seconds)})`,
        );

        const newer = oldestFirst[i + 1];
        if (newer) {
            const gapSeconds = Math.floor((newer.started_at.getTime() - session.ended_at.getTime()) / 1000);
            if (gapSeconds > 0) lines.push(`-# ↳ gap: ${formatTime(gapSeconds)}`);
        }
    });

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setThumbnail(member.displayAvatarURL())
        .setTitle(`\`${member.user.username}\`'s Session History`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Page ${page + 1} of ${pages} - ${sessions.length} session(s) total` });
}

export function buildHistoryRow(page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("history-prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId("history-next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
    );
}

export async function buildLeaderboardEmbed(guildId: string): Promise<EmbedBuilder> {
    const guildConfig = await getOrCreateGuildConfig(guildId);
    const rows = await getLeaderboard(guildId, guildConfig.quota_window_hours, 10);
    if (rows.length === 0) return EmbedFormatter.info("No activity recorded yet.");

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.discordUserId}> — ${formatTime(r.activeSeconds)} (${r.sessionCount} sessions)`);

    return new EmbedBuilder().setColor(0x5865f2).setTitle("BiomeHunt Leaderboard").setDescription(lines.join("\n"));
}

export async function getUserListPage(guildId: string, status: ActivityStatus | null): Promise<UserRow[]> {
    return getUsersByGuildStatus(guildId, status);
}

export function buildUserListEmbed(users: UserRow[], page: number, status: ActivityStatus | null): EmbedBuilder {
    const pages = Math.max(Math.ceil(users.length / USERS_PER_PAGE), 1);
    const start = page * USERS_PER_PAGE;
    const slice = users.slice(start, start + USERS_PER_PAGE);

    const lines = slice.map((u) => {
        const activity = u.last_activity_at ? `last active <t:${unix(u.last_activity_at)}:R>` : "no activity yet";
        const pausedNote = u.paused_at ? " (paused)" : "";
        return `${STATUS_EMOJI[u.current_status]} <@${u.discord_user_id}> — ${activity}${pausedNote}`;
    });

    const title = status ? `BiomeHunt Users — ${status[0].toUpperCase()}${status.slice(1)}` : "BiomeHunt Users — All";

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(title)
        .setDescription(lines.length > 0 ? lines.join("\n") : "No users match this filter.")
        .setFooter({ text: `Page ${page + 1} of ${pages} - ${users.length} user(s) total` });
}

export function buildUserListRow(page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("userlist-prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId("userlist-next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
    );
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
