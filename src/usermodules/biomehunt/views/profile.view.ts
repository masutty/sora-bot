import type { ContainerBuilder, GuildMember } from "discord.js";
import { MessageFlags } from "discord.js";
import { type CommandContext, paginationHandlers, paginationRow, type ReplyOptions, tabs, type ViewDefinition } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getActiveSecondsBetween, getActiveSecondsInWindow, getBiomeCounts, getRecentSessions } from "../repository/activity.repository";
import { getUserBadges } from "../repository/badges.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getUserQuotaProgress, type QuotaProgressRow } from "../repository/quota-roles.repository";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users.repository";
import { fixedQuotaProgressWindow, quotaDayWindow } from "../services/quota.service";
import { loadRareFinds } from "../services/rare-finds.service";
import { settings } from "../settings";
import { sessionPages, sessionsOnPage } from "./member-admin.screens";
import { loadSessionInput, sessionView } from "./session.view";
import {
    buildBadgesTabContainer,
    buildBiomesTabContainer,
    buildProfileTabContainer,
    buildQuotasTabContainer,
    buildSessionsTabContainer,
    inspectSessionRow,
    type ProfileData,
    RECENT_ACTIVITY_WINDOW_HOURS,
} from "./stats-builders";

const logger = new Logger("biomehunt.views.profile");

/** A role's progress over the stretch its mode is judged on: RW = the rolling last N hours, F = the current quota day (see `fixedQuotaProgressWindow`). */
async function computeQuotaRewardProgress(
    guildId: string,
    userId: number,
    quotaDayEnd: Date,
): Promise<Array<{ p: QuotaProgressRow; activeSeconds: number; qualifies: boolean }>> {
    const progress = await getUserQuotaProgress(guildId, userId);
    const now = new Date();
    return Promise.all(
        progress.map(async (p) => {
            let activeSeconds: number;
            if (p.mode === "F") {
                const { start, end } = fixedQuotaProgressWindow(p.quota_window_hours, quotaDayEnd, now);
                activeSeconds = await getActiveSecondsBetween(userId, start, end);
            } else {
                activeSeconds = await getActiveSecondsInWindow(userId, p.quota_window_hours);
            }
            const qualifies = activeSeconds >= p.quota_target_seconds;
            return { p, activeSeconds, qualifies };
        }),
    );
}

/** One-line-per-role summary (checkmark/X + role ping only) - used by the Quotas tab. The mark
 * reflects whether the quota is met right now, not whether the user still holds the role. */
async function getQuotaRewardSummaryLines(guildId: string, userId: number, quotaDayEnd: Date): Promise<string[]> {
    const progress = await computeQuotaRewardProgress(guildId, userId, quotaDayEnd);
    return progress.map(({ p, qualifies }) => `${qualifies ? "✅" : "❌"} <@&${p.role_id}>`);
}

/** Loads everything the Profile view's tabs render from, once upfront - `null` if the user has no
 * hunter profile in this guild. Warns if the DB round-trip is slow (see settings.diagnostics.slowProfileLoadMs). */
export async function loadProfileData(guildId: string, discordUserId: string): Promise<ProfileData | null> {
    const start = Date.now();
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return null;

    const guildConfig = await getOrCreateGuildConfig(guildId);
    const quotaDay = quotaDayWindow(guildConfig.quota_eval_hour_utc, new Date());

    const [
        activeSeconds,
        activeSecondsToday,
        biomes,
        channel,
        quotaSummaryLines,
        badges,
        sessions,
        rareFinds,
        flowersEnabled,
        economyEnabled,
    ] = await Promise.all([
        getActiveSecondsInWindow(user.id, RECENT_ACTIVITY_WINDOW_HOURS),
        getActiveSecondsBetween(user.id, quotaDay.start, quotaDay.end),
        getBiomeCounts(user.id),
        getMacroChannelByUserId(user.id),
        getQuotaRewardSummaryLines(guildId, user.id, quotaDay.end),
        getUserBadges(user.id),
        getRecentSessions(user.id, 100),
        loadRareFinds(user.id),
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
        rareFinds,
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
    /** The page of the Sessions tab. */
    page: number;
    data: ProfileData;
}

function buildTabContent(state: ProfileState, member: GuildMember): ContainerBuilder {
    const { data } = state;
    if (state.tab === "biomes") return buildBiomesTabContainer(member, data);
    if (state.tab === "badges") return buildBadgesTabContainer(member, data);
    if (state.tab === "quotas") return buildQuotasTabContainer(member, data);
    if (state.tab === "sessions") return buildSessionsTabContainer(member, data, state.page);
    return buildProfileTabContainer(member, data);
}

/**
 * Interactive Profile/Biomes/Badges/Quotas/Sessions tabbed view - data is fetched once upfront
 * (`loadProfileData`), tab switches (and session pagination) just re-render from it. Only the
 * invoker can interact (the profile owner for `/bh profile`) - default View access is "invoker".
 */
export function profileView(member: GuildMember): ViewDefinition<ProfileState, void, ProfileData> {
    return tabs<ProfileState, ProfileData>({
        name: "biomehunt.profile",
        initial: (data) => ({ tab: "profile", page: 0, data }),
        tabs: TAB_ORDER.map((key) => ({ key, label: TAB_LABELS[key] })),
        renderTab: (state, kit) => {
            const container = buildTabContent(state, member);
            const slice = state.tab === "sessions" ? sessionsOnPage(state.data, state.page) : [];
            const pages = sessionPages(state.data);
            const extraRows = [
                ...(slice.length > 0 ? [inspectSessionRow(kit, slice, state.data.rareFinds)] : []),
                ...(slice.length > 0 && pages > 1 ? [paginationRow(kit, state.page, pages)] : []),
            ];
            return { payload: { flags: MessageFlags.IsComponentsV2, components: [container] }, extraRows };
        },
        on: {
            ...paginationHandlers<ProfileState>({ pages: (s) => sessionPages(s.data) }),
            inspectSession: async (c) => {
                const id = Number(c.values[0]);
                if (!sessionsOnPage(c.state.data, c.state.page).some((x) => x.id === id)) return;
                const input = await loadSessionInput(c.state.data.user.guild_id, id);
                if (!input) {
                    await c.notify(`No session \`#${id}\` on this server.`);
                    return;
                }
                await c.open(sessionView({ back: true }), input);
            },
        },
        // Matches the old runProfileView: switching tabs always resets session pagination.
        onTabChange: (s) => {
            s.page = 0;
        },
    });
}

/**
 * Loads the target's profile and opens `profileView` on it - or replies with the "no profile yet"
 * notice without opening anything. Used by `/bh profile`.
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
