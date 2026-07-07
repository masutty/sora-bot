import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GuildMember } from "discord.js";
import type { Message } from "discord.js";
import { runButtonView } from "@/utils/buttonView";
import { EmbedFormatter, formatCodeblock, formatTime, unix } from "@/utils/format";
import {
    getActiveSecondsInWindow, getBiomeCounts, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getUserBadges } from "../repository/badges";
import { getUserQuotaProgress, type QuotaProgressRow } from "../repository/quotaRoles";
import { getGuildUserCounts, getMacroChannelByUserId, getUserByDiscordId, getUsersByGuildStatus } from "../repository/users";
import {
    ALL_BIOME_CATEGORIES, BADGE_META, BIOME_CATEGORY_LABELS, BIOME_META, formatBiomeName,
    type ActivitySessionRow, type ActivityStatus, type BiomeCategory, type UserRow,
} from "../types";

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

/** One-line-per-role summary (checkmark/X + role ping only) - used by the Quotas tab. */
export async function getQuotaRewardSummaryLines(guildId: string, userId: number): Promise<string[]> {
    const progress = await computeQuotaRewardProgress(guildId, userId);
    return progress.map(({ p, qualifies }) => `${qualifies ? "✅" : "❌"} <@&${p.role_id}>`);
}

type ProfileTab = "profile" | "biomes" | "badges" | "quotas";

const TAB_ORDER: ProfileTab[] = ["profile", "biomes", "badges", "quotas"];
const TAB_LABELS: Record<ProfileTab, string> = { profile: "Profile", biomes: "Biomes", badges: "Badges", quotas: "Quotas" };

/** Order + captions for the Profile tab's bottom "biomes found" line - fixed and positional, unlike the Biomes tab's per-category fields. */
const BIOME_TOTAL_ORDER: BiomeCategory[] = ["weather", "biome", "event", "rare"];
const BIOME_TOTAL_CAPTIONS: Record<BiomeCategory, string> = {
    weather: "Weathers", biome: "Biomes", event: "Event Biomes", rare: "Rare Biomes",
};

interface ProfileData {
    user: UserRow;
    activeSeconds: number;
    biomes: Array<{ biome: string; count: number }>;
    channelId: string | null;
    quotaSummaryLines: string[];
    badges: Awaited<ReturnType<typeof getUserBadges>>;
}

async function loadProfileData(guildId: string, discordUserId: string): Promise<ProfileData | null> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;

    const [activeSeconds, biomes, channel, quotaSummaryLines, badges] = await Promise.all([
        getActiveSecondsInWindow(user.id, RECENT_ACTIVITY_WINDOW_HOURS),
        getBiomeCounts(user.id),
        getMacroChannelByUserId(user.id),
        getQuotaRewardSummaryLines(guildId, user.id),
        getUserBadges(user.id),
    ]);

    return { user, activeSeconds, biomes, channelId: channel?.channel_id ?? null, quotaSummaryLines, badges };
}

function baseEmbed(member: GuildMember, color: number): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(color)
        .setThumbnail(member.displayAvatarURL())
        .setFooter({ text: member.user.username, iconURL: member.displayAvatarURL() })
        .setTimestamp();
}

/** Sums per-biome counts (total sightings, not distinct biomes discovered) into their category buckets. */
function totalBiomesFoundByCategory(biomes: Array<{ biome: string; count: number }>): Record<BiomeCategory, number> {
    const totals: Record<BiomeCategory, number> = { biome: 0, weather: 0, rare: 0, event: 0 };
    for (const b of biomes) {
        const category = BIOME_META[b.biome]?.category;
        if (category) totals[category] += b.count;
    }
    return totals;
}

function buildProfileTabEmbed(member: GuildMember, data: ProfileData): EmbedBuilder {
    const { user, activeSeconds, biomes, channelId, badges } = data;

    const totals = totalBiomesFoundByCategory(biomes);
    const totalLine = BIOME_TOTAL_ORDER.map((c) => `\`${totals[c]}\``).join("/");
    const captionLine = `-# (${BIOME_TOTAL_ORDER.map((c) => BIOME_TOTAL_CAPTIONS[c]).join(", ")})`;

    const embed = baseEmbed(member, STATUS_COLOR[user.current_status])
        .setTitle(`\`${member.user.username}\`'s Hunter Profile`)
        .setDescription([
            `- \`${formatTime(activeSeconds)}\` activity time in the last \`${RECENT_ACTIVITY_WINDOW_HOURS}h\`.`,
            `- Profile created <t:${Math.floor(user.created_at.getTime() / 1000)}:R>`,
            `- ${totalLine} biomes found.`,
            captionLine,
        ].join("\n"))
        .addFields(
            { name: "Macro Channel", value: channelId ? `<#${channelId}>` : formatCodeblock("No channel."), inline: true },
            { name: "Current Status", value: formatCodeblock(STATUS_EMOJI[user.current_status] + " " + user.current_status.toUpperCase()), inline: true },
        );

    if (badges.length > 0) {
        embed.addFields({ name: "Badges", value: badges.map((b) => BADGE_META[b.badge].emoji).join(" "), inline: false });
    }

    return embed;
}

function buildQuotasTabEmbed(member: GuildMember, data: ProfileData): EmbedBuilder {
    const { activeSeconds, quotaSummaryLines } = data;
    const embed = baseEmbed(member, 0x5865f2).setTitle(`\`${member.user.username}\`'s Quotas`);

    const header = `You have \`${formatTime(activeSeconds)}\` in the last ${RECENT_ACTIVITY_WINDOW_HOURS} hours.`;

    if (quotaSummaryLines.length === 0) {
        return embed.setDescription([header, "", "-# There's no quotas to meet in this server!"].join("\n"));
    }
    return embed.setDescription([header, "", ...quotaSummaryLines].join("\n"));
}

function buildBiomesTabEmbed(member: GuildMember, data: ProfileData): EmbedBuilder {
    const { biomes } = data;
    const embed = baseEmbed(member, 0x5865f2).setTitle(`\`${member.user.username}\`'s Biomes`);

    if (biomes.length === 0) return embed.setDescription("No biomes discovered yet.");

    for (const category of ALL_BIOME_CATEGORIES) {
        const inCategory = biomes.filter((b) => BIOME_META[b.biome]?.category === category);
        if (inCategory.length === 0) continue;
        const lines = [...inCategory].sort((a, b) => b.count - a.count).map((b) => `${formatBiomeName(b.biome)}: ${b.count}`);
        embed.addFields({ name: BIOME_CATEGORY_LABELS[category], value: formatCodeblock(lines.join("\n")), inline: true });
    }

    const uncategorized = biomes.filter((b) => !BIOME_META[b.biome]);
    if (uncategorized.length > 0) {
        embed.addFields({ name: "Other", value: formatCodeblock(uncategorized.map((b) => `${formatBiomeName(b.biome)}: ${b.count}`).join("\n")), inline: true });
    }

    return embed;
}

function buildBadgesTabEmbed(member: GuildMember, data: ProfileData): EmbedBuilder {
    const { badges } = data;
    const embed = baseEmbed(member, 0x5865f2).setTitle(`\`${member.user.username}\`'s Badges`);

    if (badges.length === 0) return embed.setDescription("No badges yet.");

    for (const b of badges) {
        const meta = BADGE_META[b.badge];
        embed.addFields({ name: `${meta.emoji} ${meta.display}`, value: `${meta.description}\n-# Earned <t:${unix(b.awarded_at)}:R>` });
    }

    return embed;
}

function buildTabEmbed(tab: ProfileTab, member: GuildMember, data: ProfileData): EmbedBuilder {
    if (tab === "biomes") return buildBiomesTabEmbed(member, data);
    if (tab === "badges") return buildBadgesTabEmbed(member, data);
    if (tab === "quotas") return buildQuotasTabEmbed(member, data);
    return buildProfileTabEmbed(member, data);
}

/**
 * Interactive Profile/Biomes/Badges/Quotas tabbed view - data is fetched once upfront, tab
 * switches just re-render from it. Only `invokerId` can switch tabs (the profile owner for
 * `/bh profile`, the admin who ran it for `/bh-admin user profile`).
 */
export async function runProfileView(
    guildId: string,
    member: GuildMember,
    invokerId: string,
    respond: (payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>,
): Promise<void> {
    const data = await loadProfileData(guildId, member.id);
    if (!data) {
        await respond({ embeds: [EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.")], components: [] });
        return;
    }

    await runButtonView<ProfileTab>({
        state: "profile",
        invokerId,
        respond,
        render: (tab) => ({
            embeds: [buildTabEmbed(tab, member, data)],
            buttons: TAB_ORDER.map((t) => ({
                customId: `profile-tab-${t}`,
                label: TAB_LABELS[t],
                style: t === tab ? ButtonStyle.Primary : ButtonStyle.Secondary,
                disabled: t === tab,
                next: () => t,
            })),
        }),
    });
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
            `\`#${session.id}\` <t:${unix(session.started_at)}:s> - <t:${unix(session.ended_at)}:s> (${formatTime(session.duration_seconds)})`,
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
        .setFooter({ text: `Page ${page + 1} of ${pages} - ${sessions.length} session(s) total - use the #id with \`session delete\`` });
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
