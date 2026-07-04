import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GuildMember } from "discord.js";
import { EmbedFormatter, formatCodeblock, formatTime, unix } from "@/utils/format";
import {
    getActiveSecondsInWindow, getBiomeCounts, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getUserBadges } from "../repository/badges";
import { getUserQuotaProgress, type QuotaProgressRow } from "../repository/quotaRoles";
import { getGuildUserCounts, getMacroChannelByUserId, getUserByDiscordId, getUsersByGuildStatus } from "../repository/users";
import { BADGE_META, type ActivitySessionRow, type ActivityStatus, type UserRow } from "../types";
import { Logger } from "@/utils/logging";

const logger = new Logger("biomehunt.profileViews");

export const SESSIONS_PER_PAGE = 10;
export const USERS_PER_PAGE = 10;

/** There's no general per-guild quota anymore (that's fully replaced by per-role quota rewards) - recent-activity displays just use a fixed lookback window. */
const RECENT_ACTIVITY_WINDOW_HOURS = 24;

const STATUS_EMOJI = { active: "🟢", idle: "🟡", inactive: "🔴" } as const;
const STATUS_COLOR = { active: 0x57f287, idle: 0xfaa61a, inactive: 0xed4245 } as const;

async function computeQuotaRewardProgress(guildId: string, userId: number): Promise<Array<{ p: QuotaProgressRow; activeSeconds: number; qualifies: boolean }>> {
    const progress = await getUserQuotaProgress(guildId, userId);
    return Promise.all(progress.map(async (p) => {
        const activeSeconds = await getActiveSecondsInWindow(userId, p.quota_window_hours);
        const qualifies = p.held_granted_at !== null || activeSeconds >= p.quota_target_seconds;
        return { p, activeSeconds, qualifies };
    }));
}

/**
 * Detailed per quota-role progress blocks for a user (0, 1, or many - a guild can have any
 * number of independently configured reward roles). Used by the admin-facing
 * `user quota-progress` command. Each entry is a role header followed by only the sub-lines
 * that actually add information (e.g. a held role doesn't repeat its progress).
 */
export async function getQuotaRewardLines(guildId: string, userId: number): Promise<string[]> {
    const progress = await computeQuotaRewardProgress(guildId, userId);
    return progress.map(({ p, activeSeconds, qualifies }) => {
        const modeLabel = p.mode === "F" ? "Fixed" : "Rolling Window";
        const lines = [`- <@&${p.role_id}>`];

        if (p.held_granted_at) {
            lines.push(p.mode === "F" && p.held_expires_at
                ? `> ${modeLabel}: expires <t:${unix(p.held_expires_at)}:R>`
                : `> ${modeLabel}: holds it`);
        } else {
            lines.push(`> ${modeLabel}: ${formatTime(activeSeconds)} / ${formatTime(p.quota_target_seconds)}`);
            if (qualifies) {
                lines.push(`> ${p.mode === "F" ? "Qualifies - granted at the next daily evaluation" : "Qualifies - syncs within ~30s"}`);
            }
        }

        return lines.join("\n");
    });
}

/**
 * One-line-per-role summary for the user's own `/bh profile` - just a checkmark/X and the
 * role ping, since the detailed breakdown got repetitive with several quota roles configured.
 */
export async function getQuotaRewardSummaryLines(guildId: string, userId: number): Promise<string[]> {
    const progress = await computeQuotaRewardProgress(guildId, userId);
    return progress.map(({ p, qualifies }) => `${qualifies ? "✅" : "❌"} <@&${p.role_id}>`);
}

export async function buildProfileEmbed(guildId: string, member: GuildMember): Promise<EmbedBuilder> {
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) return EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.");

    // logger.debug(`Found user: ${JSON.stringify(user, null, 2)}`);

    const activeSeconds = await getActiveSecondsInWindow(user.id, RECENT_ACTIVITY_WINDOW_HOURS);
    const biomes = await getBiomeCounts(user.id);
    const channel = await getMacroChannelByUserId(user.id);
    const quotaRewardLines = await getQuotaRewardSummaryLines(guildId, user.id);
    const badges = await getUserBadges(user.id);

    const embed = new EmbedBuilder()
        .setColor(STATUS_COLOR[user.current_status])
        .setTitle(`\`${member.user.username}\`'s hunter profile`)
        .setThumbnail(member.displayAvatarURL())
        .setDescription([
            `- \`${formatTime(activeSeconds)}\` activity time in the last \`${RECENT_ACTIVITY_WINDOW_HOURS}h\`.`,
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
        );

    if (biomes.length > 0) {
        embed.addFields({ name: "Biomes registered:", value: formatCodeblock(biomes.map((b) => `${b.biome}: ${b.count}`).join("\n")) });
    }

    if (quotaRewardLines.length > 0) {
        embed.addFields({ name: "Quota Rewards", value: quotaRewardLines.join("\n") });
    }

    if (badges.length > 0) {
        const badgeLines = badges.map((b) => `${BADGE_META[b.badge].emoji} Found ${BADGE_META[b.badge].label}!`);
        embed.addFields({ name: "Badges", value: badgeLines.join("\n") });
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
    const rows = await getLeaderboard(guildId, RECENT_ACTIVITY_WINDOW_HOURS, 10);
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
    const counts = await getGuildUserCounts(guildId);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Guild Stats")
        .addFields(
            { name: "🟢 Active", value: String(counts.active), inline: true },
            { name: "🟡 Idle", value: String(counts.idle), inline: true },
            { name: "🔴 Inactive", value: String(counts.inactive), inline: true },
        );
}
