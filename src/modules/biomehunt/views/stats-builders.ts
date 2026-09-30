import { ContainerBuilder, type GuildMember, SeparatorSpacingSize } from "discord.js";
import { formatCodeblock, formatTime, unix } from "@/utils/format";
import { BADGE_META } from "../constants/badges.constants";
import { ALL_BIOME_CATEGORIES, BIOME_CATEGORY_LABELS, BIOME_META, formatBiomeName, getBiomeAnsiColor } from "../constants/biomes.constants";
import { FLOWER_META } from "../constants/flowers.constants";
import { getLevelForXp } from "../constants/levels.constants";
import { getLeaderboard, getRecentSessions } from "../repository/activity.repository";
import type { getUserBadges } from "../repository/badges.repository";
import { getGuildUserCounts, getUserByDiscordId, getUsersByGuildStatus } from "../repository/users.repository";
import type { ActivitySessionRow, ActivityStatus, BiomeCategory, UserRow } from "../types";

export const SESSIONS_PER_PAGE = 10;
export const USERS_PER_PAGE = 10;

/** There's no general per-guild quota anymore (that's fully replaced by per-role quota rewards) - recent-activity displays just use a fixed lookback window. */
export const RECENT_ACTIVITY_WINDOW_HOURS = 24;

const STATUS_EMOJI = { active: "🟢", idle: "🟡", inactive: "🔴" } as const;
const STATUS_COLOR = { active: 0x57f287, idle: 0xfaa61a, inactive: 0xed4245 } as const;

/** Order for the Profile tab's bottom "biomes found" line - fixed and positional, unlike the Biomes tab's per-category fields. */
const BIOME_TOTAL_ORDER: BiomeCategory[] = ["weather", "biome", "event", "rare"];

/** Everything the Profile view's tabs render from - loaded once upfront by `loadProfileData`
 * (views/profile.view.ts), so tab switches and session pagination just re-render from it. */
export interface ProfileData {
    user: UserRow;
    activeSeconds: number;
    /** Active seconds since the most recent `quota_eval_hour_utc` rollover - same day boundary the
     * Fixed-mode ("F") quota reward sweep uses, not a plain UTC midnight. */
    activeSecondsToday: number;
    quotaDayStart: Date;
    quotaDayEnd: Date;
    biomes: Array<{ biome: string; count: number }>;
    channelId: string | null;
    flower: string | null;
    quotaSummaryLines: string[];
    badges: Awaited<ReturnType<typeof getUserBadges>>;
    sessions: ActivitySessionRow[];
    flowersEnabled: boolean;
    economyEnabled: boolean;
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

function baseContainer(color: number): ContainerBuilder {
    return new ContainerBuilder().setAccentColor(color);
}

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

/** Same Separator component as `addDivider`, but with no visible line - just the vertical gap
 * Discord adds around one. Used to put air between a small `-#` line and the heading below it,
 * without an actual rule cutting between them. */
function addSpacer(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small));
}

const ANSI_RESET = "\u001b[0m";

/** Per-biome ANSI color, from `BIOME_META[biome].ansiColor` - same treatment as the session-end
 * report's biome breakdown (see `ansiBiomeLine` in services/activity-session-report.service.ts). */
function ansiBiomeLine(biome: string, count: number): string {
    return `${getBiomeAnsiColor(biome)}${formatBiomeName(biome)}${ANSI_RESET}: ${count}`;
}

/** ComponentsV2 equivalent of an embed's `.setThumbnail()` - a Section pairs text with a small
 * side image (its "accessory"). Used for each tab's header line so the member's avatar still
 * shows, matching the classic-embed profile view this replaced. */
function addHeaderSection(container: ContainerBuilder, member: GuildMember, content: string): void {
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) => td.setContent(content))
            .setThumbnailAccessory((thumb) => thumb.setURL(member.displayAvatarURL())),
    );
}

export function buildProfileTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { user, biomes, channelId, flower, badges } = data;
    const container = baseContainer(STATUS_COLOR[user.current_status]);

    const channelLine = channelId ? `<#${channelId}>` : "*not created*";
    const statusLabel = user.current_status.charAt(0).toUpperCase() + user.current_status.slice(1);
    const flowerLine = flower && FLOWER_META[flower] ? `\`${FLOWER_META[flower].label}\` *(${FLOWER_META[flower].rarity})*` : "*none yet*";

    const totals = totalBiomesFoundByCategory(biomes);
    const totalLine = BIOME_TOTAL_ORDER.map((c) => `\`${totals[c]}\``).join("/");

    const { level, currentLevelXp, nextLevelXp } = getLevelForXp(user.xp);

    if (data.economyEnabled) {
        container.addTextDisplayComponents((td) =>
            td.setContent(`-# Level ${level} (${user.xp - currentLevelXp}/${nextLevelXp - currentLevelXp} XP)`),
        );
        addSpacer(container);
    }

    container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Profile`));

    addHeaderSection(
        container,
        member,
        [
            `- Status: \`${STATUS_EMOJI[user.current_status]} ${statusLabel}\``,
            `- ${totalLine} biomes found.`,
            `- Channel: ${channelLine}`,
            ...(data.flowersEnabled ? [`- Flower: ${flowerLine}`] : []),
        ].join("\n"),
    );

    if (badges.length > 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`**Badges**\n${badges.map((b) => BADGE_META[b.badge].emoji).join(" ")}`));
    }

    addDivider(container);
    const footerParts = [...(data.economyEnabled ? [`🌱 Seeds: ${user.seeds}`] : []), `member since <t:${unix(user.created_at)}:D>`];
    container.addTextDisplayComponents((td) => td.setContent(`-# ${footerParts.join(" · ")}`));

    return container;
}

function formatActivityLine(label: string, seconds: number, zeroText: string): string {
    return `- ${label}: ${seconds > 0 ? `\`${formatTime(seconds)}\`` : zeroText}`;
}

/** Discord `<t:...:t>` renders just the local time-of-day for that instant, in each viewer's own
 * timezone - the actual date on `start`/`end` doesn't matter for that, only their hour:minute do.
 * `end` is shown one minute early (23:59, not 00:00) so it doesn't read as an off-by-one. */
function formatQuotaWindowLine(start: Date, end: Date): string {
    const displayEnd = new Date(end.getTime() - 60_000);
    return `> -# from <t:${unix(start)}:t> to <t:${unix(displayEnd)}:t>`;
}

export function buildQuotasTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { activeSeconds, activeSecondsToday, quotaDayStart, quotaDayEnd, quotaSummaryLines } = data;
    const container = baseContainer(0x5865f2);

    container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Quotas`));
    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                formatActivityLine(`Your activity in the last ${RECENT_ACTIVITY_WINDOW_HOURS}h`, activeSeconds, "No activity detected"),
                formatActivityLine("Your activity today", activeSecondsToday, "No activity detected"),
                formatQuotaWindowLine(quotaDayStart, quotaDayEnd),
            ].join("\n"),
        ),
    );
    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(quotaSummaryLines.length === 0 ? "-# There's no quotas to meet in this server!" : quotaSummaryLines.join("\n")),
    );

    return container;
}

export function buildBiomesTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { biomes } = data;
    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Biomes`));

    if (biomes.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No biomes discovered yet."));
        return container;
    }

    const totals = totalBiomesFoundByCategory(biomes);

    for (const category of ALL_BIOME_CATEGORIES) {
        const inCategory = biomes.filter((b) => BIOME_META[b.biome]?.category === category);
        if (inCategory.length === 0) continue;
        const lines = [...inCategory].sort((a, b) => b.count - a.count).map((b) => ansiBiomeLine(b.biome, b.count));
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent(`**${BIOME_CATEGORY_LABELS[category]} (${totals[category]})**\n${formatCodeblock(lines.join("\n"), "ansi")}`),
        );
    }

    const uncategorized = biomes.filter((b) => !BIOME_META[b.biome]);
    if (uncategorized.length > 0) {
        const uncategorizedTotal = uncategorized.reduce((sum, b) => sum + b.count, 0);
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent(
                `**Other (${uncategorizedTotal})**\n${formatCodeblock(uncategorized.map((b) => `${formatBiomeName(b.biome)}: ${b.count}`).join("\n"))}`,
            ),
        );
    }

    return container;
}

export function buildBadgesTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { badges } = data;
    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Badges`));

    if (badges.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No badges yet."));
        return container;
    }

    for (const b of badges) {
        const meta = BADGE_META[b.badge];
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent(`**${meta.emoji} ${meta.display}**\n${meta.description}\n-# Earned <t:${unix(b.awarded_at)}:R>`),
        );
    }

    return container;
}

/** Container version of buildHistoryEmbed's content, for the ComponentsV2 profile view - the
 * classic embed version stays as-is for `!bh-admin member session-view`'s own pagination. */
export function buildSessionsTabContainer(member: GuildMember, data: ProfileData, page: number): ContainerBuilder {
    const container = baseContainer(0x5865f2);
    const { sessions, user } = data;

    if (sessions.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Sessions\nNo activity recorded yet.`));
        return container;
    }

    // While active, `sessions[0]` (newest-first) IS the current burst - activity-ingest.service keeps
    // extending its ended_at/duration_seconds live on every incoming message, it's not "finished"
    // yet. Called out separately instead of listed as just another completed entry.
    const ongoing = user.current_status === "active" ? sessions[0] : null;
    const completed = ongoing ? sessions.slice(1) : sessions;

    const pages = Math.max(Math.ceil(completed.length / SESSIONS_PER_PAGE), 1);
    const start = page * SESSIONS_PER_PAGE;
    const slice = completed.slice(start, start + SESSIONS_PER_PAGE);

    container.addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Session History`));
    addDivider(container);

    const lines: string[] = [];
    if (ongoing && page === 0) lines.push(`🟢 Currently macroing (started <t:${unix(ongoing.started_at)}:R>)`);
    if (slice.length === 0) {
        lines.push(ongoing ? "*No completed sessions yet.*" : "No activity recorded yet.");
    } else {
        for (const session of slice) {
            lines.push(`⏱️ \`#${session.id}\` · \`${formatTime(session.duration_seconds)}\` · ended <t:${unix(session.ended_at)}:R>`);
        }
    }
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));

    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# Page ${page + 1} of ${pages}, ${completed.length} total sessions`));

    return container;
}

export async function getSessionHistory(guildId: string, discordUserId: string, limit = 100): Promise<ActivitySessionRow[] | null> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;
    return getRecentSessions(user.id, limit);
}

/** Standalone (non-tab) container for `!bh-admin session view` - paginated via `paginate`. */
export function buildHistoryContainer(sessions: ActivitySessionRow[], member: GuildMember, page: number): ContainerBuilder {
    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    const start = page * SESSIONS_PER_PAGE;
    const slice = sessions.slice(start, start + SESSIONS_PER_PAGE);
    const oldestFirst = [...slice].reverse();

    const lines = oldestFirst.map(
        (session) =>
            `\`#${session.id}\` <t:${unix(session.started_at)}:s> - <t:${unix(session.ended_at)}:s> (${formatTime(session.duration_seconds)})`,
    );

    const container = baseContainer(0x5865f2);
    addHeaderSection(container, member, `**\`${member.user.username}\`'s Session History**\n${lines.join("\n")}`);
    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# Page ${page + 1} of ${pages} · ${sessions.length} session(s) total`));
    return container;
}

export async function buildLeaderboardContainer(guildId: string): Promise<ContainerBuilder> {
    const rows = await getLeaderboard(guildId, RECENT_ACTIVITY_WINDOW_HOURS, 10);
    const container = baseContainer(0x5865f2);

    if (rows.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("-# ℹ️ No activity recorded yet."));
        return container;
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.discordUserId}> - ${formatTime(r.activeSeconds)} (${r.sessionCount} sessions)`);
    container.addTextDisplayComponents((td) => td.setContent(`**Leaderboard**\n${lines.join("\n")}`));
    return container;
}

export async function getUserListPage(guildId: string, status: ActivityStatus | null): Promise<UserRow[]> {
    return getUsersByGuildStatus(guildId, status);
}

export function buildUserListContainer(users: UserRow[], page: number, status: ActivityStatus | null): ContainerBuilder {
    const pages = Math.max(Math.ceil(users.length / USERS_PER_PAGE), 1);
    const start = page * USERS_PER_PAGE;
    const slice = users.slice(start, start + USERS_PER_PAGE);

    const lines = slice.map((u) => {
        const activity = u.last_activity_at ? `last active <t:${unix(u.last_activity_at)}:R>` : "no activity yet";
        const pausedNote = u.paused_at ? " (paused)" : "";
        return `${STATUS_EMOJI[u.current_status]} <@${u.discord_user_id}> - ${activity}${pausedNote}`;
    });

    const title = status ? `Users - ${status[0].toUpperCase()}${status.slice(1)}` : "Users - All";
    const body = lines.length > 0 ? lines.join("\n") : "No users match this filter.";

    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`**${title}**\n${body}`));
    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# Page ${page + 1} of ${pages} · ${users.length} user(s) total`));
    return container;
}

export async function buildGuildStatsContainer(guildId: string): Promise<ContainerBuilder> {
    const counts = await getGuildUserCounts(guildId);

    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                "**Guild Stats**",
                `- 🟢 Active: \`${counts.active}\``,
                `- 🟡 Idle: \`${counts.idle}\``,
                `- 🔴 Inactive: \`${counts.inactive}\``,
            ].join("\n"),
        ),
    );
    return container;
}
