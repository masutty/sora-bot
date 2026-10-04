import type { ContainerBuilder, GuildMember } from "discord.js";
import { MessageFlags } from "discord.js";
import { type CommandContext, type ReplyOptions, tabs, type ViewDefinition } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getActiveSecondsBetween, getActiveSecondsInWindow, getBiomeCounts, getRecentSessions } from "../repository/activity.repository";
import { getUserBadges } from "../repository/badges.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getUserQuotaProgress, type QuotaProgressRow } from "../repository/quota-roles.repository";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users.repository";
import { quotaDayWindow } from "../services/quota-report.service";
import { settings } from "../settings";
import {
    buildBadgesTabContainer,
    buildBiomesTabContainer,
    buildProfileTabContainer,
    buildQuotasTabContainer,
    buildSessionsTabContainer,
    type ProfileData,
    RECENT_ACTIVITY_WINDOW_HOURS,
    SESSIONS_PER_PAGE,
} from "./stats-builders";

const logger = new Logger("biomehunt.views.profile");

async function computeQuotaRewardProgress(
    guildId: string,
    userId: number,
): Promise<Array<{ p: QuotaProgressRow; activeSeconds: number; qualifies: boolean }>> {
    const progress = await getUserQuotaProgress(guildId, userId);
    return Promise.all(
        progress.map(async (p) => {
            const activeSeconds = await getActiveSecondsInWindow(userId, p.quota_window_hours);
            const qualifies = activeSeconds >= p.quota_target_seconds;
            return { p, activeSeconds, qualifies };
        }),
    );
}

/** One-line-per-role summary (checkmark/X + role ping only) - used by the Quotas tab. The mark
 * reflects whether the quota is met right now, not whether the user still holds the role. */
async function getQuotaRewardSummaryLines(guildId: string, userId: number): Promise<string[]> {
    const progress = await computeQuotaRewardProgress(guildId, userId);
    return progress.map(({ p, qualifies }) => `${qualifies ? "✅" : "❌"} <@&${p.role_id}>`);
}

/** Loads everything the Profile view's tabs render from, once upfront - `null` if the user has no
 * BiomeHunt profile in this guild. Warns if the DB round-trip is slow (see settings.diagnostics.slowProfileLoadMs). */
export async function loadProfileData(guildId: string, discordUserId: string): Promise<ProfileData | null> {
    const start = Date.now();
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;

    const guildConfig = await getOrCreateGuildConfig(guildId);
    const quotaDay = quotaDayWindow(guildConfig.quota_eval_hour_utc, new Date());

    const [activeSeconds, activeSecondsToday, biomes, channel, quotaSummaryLines, badges, sessions, flowersEnabled, economyEnabled] =
        await Promise.all([
            getActiveSecondsInWindow(user.id, RECENT_ACTIVITY_WINDOW_HOURS),
            getActiveSecondsBetween(user.id, quotaDay.start, quotaDay.end),
            getBiomeCounts(user.id),
            getMacroChannelByUserId(user.id),
            getQuotaRewardSummaryLines(guildId, user.id),
            getUserBadges(user.id),
            getRecentSessions(user.id, 100),
            isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"),
            isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"),
        ]);

    const elapsedMs = Date.now() - start;
    if (elapsedMs > settings.diagnostics.slowProfileLoadMs) {
        logger.warn(`Slow profile data load: ${elapsedMs}ms (DB-bound - see database pool stats)`, { guildId, userId: user.id });
    }

    return {
        user,
        activeSeconds,
        activeSecondsToday,
        quotaDayStart: quotaDay.start,
        quotaDayEnd: quotaDay.end,
        biomes,
        channelId: channel?.channel_id ?? null,
        flower: user.flower,
        quotaSummaryLines,
        badges,
        sessions,
        flowersEnabled,
        economyEnabled,
    };
}

type ProfileTab = "profile" | "biomes" | "badges" | "quotas" | "sessions";

const TAB_ORDER: ProfileTab[] = ["profile", "biomes", "badges", "quotas", "sessions"];
const TAB_LABELS: Record<ProfileTab, string> = {
    profile: "Profile",
    biomes: "Biomes",
    badges: "Badges",
    quotas: "Quotas",
    sessions: "Sessions",
};

interface ProfileState {
    tab: string;
    sessionPage: number;
    data: ProfileData;
}

function buildTabContent(state: ProfileState, member: GuildMember): ContainerBuilder {
    const { data } = state;
    if (state.tab === "biomes") return buildBiomesTabContainer(member, data);
    if (state.tab === "badges") return buildBadgesTabContainer(member, data);
    if (state.tab === "quotas") return buildQuotasTabContainer(member, data);
    if (state.tab === "sessions") return buildSessionsTabContainer(member, data, state.sessionPage);
    return buildProfileTabContainer(member, data);
}

/**
 * Interactive Profile/Biomes/Badges/Quotas/Sessions tabbed view - data is fetched once upfront
 * (`loadProfileData`), tab switches (and session pagination) just re-render from it. Only the
 * invoker can interact (the profile owner for `/bh profile`, the admin who ran it for `/bh-admin
 * profile` - default View access is "invoker").
 */
export function profileView(member: GuildMember): ViewDefinition<ProfileState, void, ProfileData> {
    return tabs<ProfileState, ProfileData>({
        name: "biomehunt.profile",
        initial: (data) => ({ tab: "profile", sessionPage: 0, data }),
        tabs: TAB_ORDER.map((key) => ({ key, label: TAB_LABELS[key] })),
        renderTab: (state, kit) => {
            const container = buildTabContent(state, member);
            const sessionsPages = state.tab === "sessions" ? Math.max(Math.ceil(state.data.sessions.length / SESSIONS_PER_PAGE), 1) : 1;
            const extraRows =
                state.tab === "sessions" && sessionsPages > 1
                    ? [
                          kit.row(
                              kit.button("sessionsPrev", (b) => b.setEmoji("◀️").setDisabled(state.sessionPage === 0)),
                              kit.button("sessionsNext", (b) => b.setEmoji("▶️").setDisabled(state.sessionPage >= sessionsPages - 1)),
                          ),
                      ]
                    : [];
            return { payload: { flags: MessageFlags.IsComponentsV2, components: [container] }, extraRows };
        },
        on: {
            sessionsPrev: (c) => {
                c.state.sessionPage = Math.max(0, c.state.sessionPage - 1);
            },
            sessionsNext: (c) => {
                const pages = Math.max(Math.ceil(c.state.data.sessions.length / SESSIONS_PER_PAGE), 1);
                c.state.sessionPage = Math.min(pages - 1, c.state.sessionPage + 1);
            },
        },
        // Matches the old runProfileView: switching tabs always resets session pagination.
        onTabChange: (s) => {
            s.sessionPage = 0;
        },
    });
}

/**
 * Loads the target's profile and opens `profileView` on it - or replies with the "no profile yet"
 * notice without opening anything. Shared by `/bh profile` and `/bh-admin profile`.
 */
export async function openProfileView(ctx: CommandContext, guildId: string, member: GuildMember, opts?: ReplyOptions): Promise<void> {
    const data = await loadProfileData(guildId, member.id);
    if (!data) {
        await ctx.reply(
            { ...EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."), allowedMentions: NO_PINGS },
            opts,
        );
        return;
    }
    await ctx.open(profileView(member), data, opts);
}
