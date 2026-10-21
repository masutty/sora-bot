import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getActiveSecondsInWindow, getGuildActiveSecondsBetween } from "../repository/activity.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getGuildsDueForFixedRewardEval, getOrCreateGuildConfig, markQuotaEvaluated } from "../repository/guilds.repository";
import {
    deleteQuotaRole,
    getQuotaRolesByMode,
    getQuotaRolesForGuild,
    getUserQuotaRole,
    grantQuotaRole,
    revokeQuotaRole,
    upsertQuotaRole,
} from "../repository/quota-roles.repository";
import { enqueueRoleJob, scheduleRoleRemoval } from "../repository/role-jobs.repository";
import { getMacroChannelByUserId, getUserById, getUsersForGuild } from "../repository/users.repository";
import { BiomeHuntError, type QuotaRoleMode, type QuotaRoleRow, type UserRow } from "../types";

const logger = new Logger("biomehunt.services.quota");

/* Fixed mode is a daily reward, so its window is always 24h. */
const DAILY_WINDOW_HOURS = 24;

export async function createQuota(
    guildId: string,
    roleId: string,
    mode: QuotaRoleMode,
    quotaHours: number,
    quotaWindowHours: number,
    accessDurationDays: number | null,
): Promise<string> {
    if (mode !== "F" && mode !== "RW") {
        throw new BiomeHuntError("mode must be either F (Fixed) or RW (Rolling Window).");
    }
    if (quotaHours <= 0 || (mode === "RW" && quotaWindowHours <= 0)) {
        throw new BiomeHuntError("Quota hours and window must be greater than zero.");
    }
    if (mode === "F" && (!accessDurationDays || accessDurationDays <= 0)) {
        throw new BiomeHuntError("access_duration_days is required and must be greater than zero when mode is F.");
    }
    if (mode === "RW" && accessDurationDays !== null) {
        throw new BiomeHuntError("access_duration_days isn't used in RW mode - omit it.");
    }

    const windowHours = mode === "F" ? DAILY_WINDOW_HOURS : quotaWindowHours;
    await upsertQuotaRole(guildId, roleId, mode, Math.round(quotaHours * 3600), windowHours, mode === "F" ? accessDurationDays : null);

    const modeLabel = mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = mode === "F" ? `, ${accessDurationDays} day(s) access` : "";
    return `Quota role <@&${roleId}> created: ${modeLabel} mode, ${quotaHours}h within a ${windowHours}h window${durationNote}.`;
}

export async function removeQuotaRole(guildId: string, roleId: string): Promise<string> {
    const removed = await deleteQuotaRole(guildId, roleId);
    if (!removed) throw new BiomeHuntError("That quota role isn't configured.");
    return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
}

export async function forceQuotaEval(client: BotClient, guildId: string): Promise<string> {
    const count = await evaluateFixedRewardsForGuild(client, guildId);
    if (count === 0) throw new BiomeHuntError("No daily rewards are set up for this server.");
    await markQuotaEvaluated(guildId);
    return `Checked ${count} daily ${count === 1 ? "reward" : "rewards"}.`;
}

/**
 * RW-mode: continuous reactive check. Called once per user per status worker
 * tick (same 30s cadence, same per-user loop) — grants/revokes immediately on
 * a compliance state change, no-ops otherwise so it never spams the role queue.
 */
export async function evaluateRollingRewards(client: BotClient, user: UserRow): Promise<void> {
    const roles = await getQuotaRolesByMode(user.guild_id, "RW");
    for (const role of roles) {
        await evaluateRollingReward(client, user, role);
    }
}

async function evaluateRollingReward(client: BotClient, user: UserRow, role: QuotaRoleRow): Promise<void> {
    const activeSeconds = await getActiveSecondsInWindow(user.id, role.quota_window_hours);
    const compliant = activeSeconds >= role.quota_target_seconds;
    const held = await getUserQuotaRole(user.id, role.id);

    if (compliant && !held) {
        await grantQuotaRole(user.id, role.id, null);
        await enqueueRoleJob(user.guild_id, user.id, role.role_id, "add");
        if (await isFlagEnabled(user.guild_id, "PING_ON_QUOTA_MET")) await pingQuotaMet(client, user.id, role.role_id);
    } else if (!compliant && held) {
        await revokeQuotaRole(user.id, role.id);
        await enqueueRoleJob(user.guild_id, user.id, role.role_id, "remove");
    }
}

/**
 * F-mode: once-a-day, per-guild sweep. Grants/renews access for users who
 * qualify (postponing any pending removal instead of stacking one); users
 * who don't qualify simply aren't renewed — an already-held role isn't cut
 * early, it just expires on its already-scheduled job.
 */
/** Returns the number of Fixed-mode roles evaluated (0 if none are configured for this guild). */
export async function evaluateFixedRewardsForGuild(client: BotClient, guildId: string): Promise<number> {
    const roles = await getQuotaRolesByMode(guildId, "F");
    if (roles.length === 0) return 0;

    const users = await getUsersForGuild(guildId);
    const pingEnabled = await isFlagEnabled(guildId, "PING_ON_QUOTA_MET");

    for (const user of users) {
        for (const role of roles) {
            // Always set for mode F (createQuota rejects an F role without it) - narrows the type.
            if (role.access_duration_days === null) continue;
            const activeSeconds = await getActiveSecondsInWindow(user.id, role.quota_window_hours);
            if (activeSeconds < role.quota_target_seconds) continue;

            const held = await getUserQuotaRole(user.id, role.id);
            const expiresAt = new Date(Date.now() + role.access_duration_days * 86_400_000);

            await grantQuotaRole(user.id, role.id, expiresAt);
            if (!held) {
                await enqueueRoleJob(guildId, user.id, role.role_id, "add");
                if (pingEnabled) await pingQuotaMet(client, user.id, role.role_id);
            }
            await scheduleRoleRemoval(guildId, user.id, role.role_id, expiresAt);
        }
    }
    return roles.length;
}

/** Runs the F-mode daily sweep for every guild that's currently due for it. Call once per status worker tick. */
export async function runFixedRewardSweep(client: BotClient): Promise<void> {
    const dueGuilds = await getGuildsDueForFixedRewardEval();
    for (const guild of dueGuilds) {
        try {
            await evaluateFixedRewardsForGuild(client, guild.guild_id);
            await markQuotaEvaluated(guild.guild_id);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: guild.guild_id });
        }
    }
}

/** Posts a "you just met the quota" ping to a user's macro channel, if they still have one. */
async function pingQuotaMet(client: BotClient, userId: number, roleId: string): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    try {
        await channel.send({
            content: `🎉 <@${user.discord_user_id}> just met the quota for <@&${roleId}>!`,
            allowedMentions: { ...NO_PINGS, users: [user.discord_user_id] },
        });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId, roleId });
    }
}

/**
 * A "quota day"'s `[start, end)` - the most recent occurrence of `quotaEvalHourUtc` (UTC) at or
 * before `now`, through the same hour 24h later; `daysBack` steps back whole days (1 = yesterday).
 * Mirrors the day boundary the Fixed-mode quota sweep rolls over on (see
 * `getGuildsDueForFixedRewardEval`), so "today" always lines up with when that reward resets.
 */
export function quotaDayWindow(quotaEvalHourUtc: number, now: Date, daysBack = 0): { start: Date; end: Date } {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), quotaEvalHourUtc, 0, 0, 0));
    if (start > now) start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCDate(start.getUTCDate() - daysBack);
    return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Where an F-mode (fixed, daily) quota's progress is counted right now: the stretch the next sweep
 * will look at - its `quota_window_hours` ending at the current quota day's end - up to `now`. For
 * a 24h window that's simply "today's quota day so far", NOT the last 24 hours, which would count
 * yesterday's quota day too.
 */
export function fixedQuotaProgressWindow(windowHours: number, quotaDayEnd: Date, now: Date): { start: Date; end: Date } {
    return { start: new Date(quotaDayEnd.getTime() - windowHours * 3_600_000), end: now };
}

export interface QuotaMember {
    discordUserId: string;
    activeSeconds: number;
}

export interface QuotaDayReport {
    start: Date;
    end: Date;
    /** `true` for today's quota day - it hasn't ended, so "missed" still means "not yet". */
    inProgress: boolean;
    roles: QuotaRoleRow[];
    /** Every counted member, most active first - one list for all roles; each role splits it at its own target. */
    members: QuotaMember[];
}

/** How many of `members` (sorted, most active first) hit `targetSeconds` - they're the first `n`. */
export function hitCount(members: QuotaMember[], targetSeconds: number): number {
    const firstMiss = members.findIndex((m) => m.activeSeconds < targetSeconds);
    return firstMiss === -1 ? members.length : firstMiss;
}

/**
 * Who hit each quota role's target within one quota day. Counts every non-paused member still in
 * the server (`isInGuild`), including ones with no activity (0, so they miss). The target is compared
 * against the activity inside the quota day itself - for a role whose own window isn't 24h this is
 * an approximation, which the view points out.
 */
export async function loadQuotaDayReport(
    guildId: string,
    daysBack: number,
    isInGuild: (discordUserId: string) => boolean,
    now = new Date(),
): Promise<QuotaDayReport> {
    const config = await getOrCreateGuildConfig(guildId);
    const { start, end } = quotaDayWindow(config.quota_eval_hour_utc, now, daysBack);
    const [roles, members] = await Promise.all([getQuotaRolesForGuild(guildId), getGuildActiveSecondsBetween(guildId, start, end)]);

    return {
        start,
        end,
        inProgress: now < end,
        roles,
        members: members
            .filter((m) => isInGuild(m.discordUserId))
            .map((m) => ({ discordUserId: m.discordUserId, activeSeconds: m.activeSeconds }))
            .sort((a, b) => b.activeSeconds - a.activeSeconds),
    };
}
