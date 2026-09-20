import {
    ButtonStyle, ContainerBuilder, GuildMember,
    MessageFlags, SeparatorSpacingSize,
} from "discord.js";
import type { Message } from "discord.js";
import { runButtonView, type ButtonViewButton, type ButtonViewFinalPayload, type ButtonViewRender } from "@/utils/buttonView";
import { EmbedFormatter, formatCodeblock, formatTime, unix } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { FLOWER_META } from "../flowers";
import {
    getActiveSecondsInWindow, getBiomeCounts, getLeaderboard, getRecentSessions,
} from "../repository/activity";
import { getUserBadges } from "../repository/badges";
import { isFlagEnabled } from "../repository/flags";
import { getUserQuotaProgress, type QuotaProgressRow } from "../repository/quotaRoles";
import { getGuildUserCounts, getMacroChannelByUserId, getUserByDiscordId, getUsersByGuildStatus } from "../repository/users";
import {
    ALL_BIOME_CATEGORIES, BADGE_META, BIOME_CATEGORY_LABELS, BIOME_META, formatBiomeName, formatSeedsFooter,
    type ActivitySessionRow, type ActivityStatus, type BiomeCategory, type UserRow,
} from "../types";

const logger = new Logger("biomehunt.profileViews");

/** Above this, `loadProfileData`'s DB round-trip is the likely bottleneck for a "profile felt slow" complaint - as opposed to Discord API slowness on the button clicks (see utils/buttonView.ts's own timing). */
const SLOW_PROFILE_LOAD_MS = 500;

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

type ProfileTab = "profile" | "biomes" | "badges" | "quotas" | "sessions";

const TAB_ORDER: ProfileTab[] = ["profile", "biomes", "badges", "quotas", "sessions"];
const TAB_LABELS: Record<ProfileTab, string> = { profile: "Profile", biomes: "Biomes", badges: "Badges", quotas: "Quotas", sessions: "Sessions" };

interface ProfileState {
    tab: ProfileTab;
    sessionPage: number;
}

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
    flower: string | null;
    quotaSummaryLines: string[];
    badges: Awaited<ReturnType<typeof getUserBadges>>;
    sessions: ActivitySessionRow[];
    flowersEnabled: boolean;
    economyEnabled: boolean;
}

async function loadProfileData(guildId: string, discordUserId: string): Promise<ProfileData | null> {
    const start = Date.now();
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;

    const [activeSeconds, biomes, channel, quotaSummaryLines, badges, sessions, flowersEnabled, economyEnabled] = await Promise.all([
        getActiveSecondsInWindow(user.id, RECENT_ACTIVITY_WINDOW_HOURS),
        getBiomeCounts(user.id),
        getMacroChannelByUserId(user.id),
        getQuotaRewardSummaryLines(guildId, user.id),
        getUserBadges(user.id),
        getRecentSessions(user.id, 100),
        isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"),
        isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"),
    ]);

    const elapsedMs = Date.now() - start;
    if (elapsedMs > SLOW_PROFILE_LOAD_MS) {
        logger.warn(`Slow profile data load: ${elapsedMs}ms (DB-bound - see database pool stats)`, { guildId, userId: user.id });
    }

    return {
        user, activeSeconds, biomes, channelId: channel?.channel_id ?? null, flower: channel?.flower ?? null,
        quotaSummaryLines, badges, sessions, flowersEnabled, economyEnabled,
    };
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

function buildProfileTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { user, biomes, channelId, flower, badges } = data;
    const container = baseContainer(STATUS_COLOR[user.current_status]);

    const channelLine = channelId ? `<#${channelId}>` : "*not created*";
    const statusLabel = user.current_status.charAt(0).toUpperCase() + user.current_status.slice(1);
    const flowerLine = flower && FLOWER_META[flower]
        ? `\`${FLOWER_META[flower].label}\` (${FLOWER_META[flower].rarity})`
        : "*none yet*";

    const totals = totalBiomesFoundByCategory(biomes);
    const totalLine = BIOME_TOTAL_ORDER.map((c) => `\`${totals[c]}\``).join("/");

    const seedsLevelLine = formatSeedsFooter(user.seeds, user.xp);

    addHeaderSection(
        container,
        member,
        [
            `**\`${member.user.username}\`'s Profile**`,
            `- Profile created <t:${Math.floor(user.created_at.getTime() / 1000)}:R>`,
            `- Channel: ${channelLine}`,
            ...(data.flowersEnabled ? [`- Flower: ${flowerLine}`] : []),
            `- Status: \`${STATUS_EMOJI[user.current_status]} ${statusLabel}\``,
            `- ${totalLine} biomes found.`,
            ...(data.economyEnabled ? [seedsLevelLine] : []),
        ].join("\n"),
    );

    if (badges.length > 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`**Badges**\n${badges.map((b) => BADGE_META[b.badge].emoji).join(" ")}`));
    }

    return container;
}

function buildQuotasTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { activeSeconds, quotaSummaryLines } = data;
    const container = baseContainer(0x5865f2);

    const header = `**\`${member.user.username}\`'s Quotas**\nYou have \`${formatTime(activeSeconds)}\` in the last ${RECENT_ACTIVITY_WINDOW_HOURS} hours.`;
    const body = quotaSummaryLines.length === 0
        ? "-# There's no quotas to meet in this server!"
        : quotaSummaryLines.join("\n");

    container.addTextDisplayComponents((td) => td.setContent(`${header}\n\n${body}`));
    return container;
}

function buildBiomesTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { biomes } = data;
    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`**\`${member.user.username}\`'s Biomes**`));

    if (biomes.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No biomes discovered yet."));
        return container;
    }

    const totals = totalBiomesFoundByCategory(biomes);
    const summaryLine = BIOME_TOTAL_ORDER.map((c) => `${BIOME_TOTAL_CAPTIONS[c]}: \`${totals[c]}\``).join(" · ");
    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(summaryLine));

    for (const category of ALL_BIOME_CATEGORIES) {
        const inCategory = biomes.filter((b) => BIOME_META[b.biome]?.category === category);
        if (inCategory.length === 0) continue;
        const lines = [...inCategory].sort((a, b) => b.count - a.count).map((b) => `${formatBiomeName(b.biome)}: ${b.count}`);
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`**${BIOME_CATEGORY_LABELS[category]}**\n${formatCodeblock(lines.join("\n"))}`));
    }

    const uncategorized = biomes.filter((b) => !BIOME_META[b.biome]);
    if (uncategorized.length > 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent(`**Other**\n${formatCodeblock(uncategorized.map((b) => `${formatBiomeName(b.biome)}: ${b.count}`).join("\n"))}`),
        );
    }

    return container;
}

function buildBadgesTabContainer(member: GuildMember, data: ProfileData): ContainerBuilder {
    const { badges } = data;
    const container = baseContainer(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`**\`${member.user.username}\`'s Badges**`));

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
function buildSessionsTabContainer(member: GuildMember, data: ProfileData, page: number): ContainerBuilder {
    const container = baseContainer(0x5865f2);
    const { sessions } = data;

    if (sessions.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent(`**\`${member.user.username}\`'s Sessions**\nNo activity recorded yet.`));
        return container;
    }

    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    const start = page * SESSIONS_PER_PAGE;
    const slice = sessions.slice(start, start + SESSIONS_PER_PAGE);
    const oldestFirst = [...slice].reverse();

    const lines = oldestFirst.map((session) =>
        `\`#${session.id}\` <t:${unix(session.started_at)}:s> - <t:${unix(session.ended_at)}:s> (${formatTime(session.duration_seconds)})`,
    );

    container.addTextDisplayComponents((td) => td.setContent(`**\`${member.user.username}\`'s Session History**\n${lines.join("\n")}`));
    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# Page ${page + 1} of ${pages} · ${sessions.length} session(s) total`));

    return container;
}

function buildTabContainer(state: ProfileState, member: GuildMember, data: ProfileData): ContainerBuilder {
    if (state.tab === "biomes") return buildBiomesTabContainer(member, data);
    if (state.tab === "badges") return buildBadgesTabContainer(member, data);
    if (state.tab === "quotas") return buildQuotasTabContainer(member, data);
    if (state.tab === "sessions") return buildSessionsTabContainer(member, data, state.sessionPage);
    return buildProfileTabContainer(member, data);
}

/**
 * Interactive Profile/Biomes/Badges/Quotas/Sessions tabbed view - data is fetched once upfront,
 * tab switches (and session pagination) just re-render from it. Only `invokerId` can interact
 * (the profile owner for `/bh profile`, the admin who ran it for `/bh-admin profile`).
 */
export async function runProfileView(
    guildId: string,
    member: GuildMember,
    invokerId: string,
    respond: (payload: ButtonViewFinalPayload) => Promise<Message>,
): Promise<void> {
    const data = await loadProfileData(guildId, member.id);
    if (!data) {
        await respond(EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."));
        return;
    }

    await runButtonView<ProfileState>({
        state: { tab: "profile", sessionPage: 0 },
        invokerId,
        respond,
        render: (state): ButtonViewRender<ProfileState> => {
            const tabRow: ButtonViewButton<ProfileState>[] = TAB_ORDER.map((t) => ({
                customId: `profile-tab-${t}`,
                label: TAB_LABELS[t],
                style: t === state.tab ? ButtonStyle.Primary : ButtonStyle.Secondary,
                disabled: t === state.tab,
                next: (): ProfileState => ({ tab: t, sessionPage: 0 }),
            }));

            const rows: ButtonViewButton<ProfileState>[][] = [tabRow];

            if (state.tab === "sessions") {
                const pages = Math.max(Math.ceil(data.sessions.length / SESSIONS_PER_PAGE), 1);
                if (pages > 1) {
                    rows.push([
                        {
                            customId: "profile-sessions-prev", emoji: "◀️", style: ButtonStyle.Secondary,
                            disabled: state.sessionPage === 0,
                            next: (s): ProfileState => ({ ...s, sessionPage: Math.max(0, s.sessionPage - 1) }),
                        },
                        {
                            customId: "profile-sessions-next", emoji: "▶️", style: ButtonStyle.Secondary,
                            disabled: state.sessionPage >= pages - 1,
                            next: (s): ProfileState => ({ ...s, sessionPage: Math.min(pages - 1, s.sessionPage + 1) }),
                        },
                    ]);
                }
            }

            return {
                payload: { flags: MessageFlags.IsComponentsV2, components: [buildTabContainer(state, member, data)] },
                buttons: rows,
            };
        },
    });
}

export async function getSessionHistory(guildId: string, discordUserId: string, limit = 100): Promise<ActivitySessionRow[] | null> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;
    return getRecentSessions(user.id, limit);
}

/** Standalone (non-tab) container for `!bh-admin session view` - paginated via `attachPagination`. */
export function buildHistoryContainer(sessions: ActivitySessionRow[], member: GuildMember, page: number): ContainerBuilder {
    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    const start = page * SESSIONS_PER_PAGE;
    const slice = sessions.slice(start, start + SESSIONS_PER_PAGE);
    const oldestFirst = [...slice].reverse();

    const lines = oldestFirst.map((session) =>
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
