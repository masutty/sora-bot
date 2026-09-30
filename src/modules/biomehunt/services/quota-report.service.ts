import { getGuildActiveSecondsBetween } from "../repository/activity.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getQuotaRolesForGuild } from "../repository/quota-roles.repository";
import type { QuotaRoleRow } from "../types";

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

export interface QuotaMember {
    discordUserId: string;
    activeSeconds: number;
}

export interface QuotaRoleResult {
    role: QuotaRoleRow;
    /** Most active first. */
    hit: QuotaMember[];
    /** Most active first. */
    missed: QuotaMember[];
}

export interface QuotaDayReport {
    start: Date;
    end: Date;
    /** `true` for today's quota day - it hasn't ended, so "missed" still means "not yet". */
    inProgress: boolean;
    roles: QuotaRoleResult[];
}

/**
 * Who hit each quota role's target within one quota day. Every non-paused member counts, including
 * ones with no activity (they land in `missed`). The target is compared against the activity inside
 * the quota day itself - for a role whose own window isn't 24h this is an approximation, which the
 * view points out.
 */
export async function loadQuotaDayReport(guildId: string, daysBack: number, now = new Date()): Promise<QuotaDayReport> {
    const config = await getOrCreateGuildConfig(guildId);
    const { start, end } = quotaDayWindow(config.quota_eval_hour_utc, now, daysBack);
    const [roles, members] = await Promise.all([getQuotaRolesForGuild(guildId), getGuildActiveSecondsBetween(guildId, start, end)]);

    const sorted = members
        .map((m) => ({ discordUserId: m.discordUserId, activeSeconds: m.activeSeconds }))
        .sort((a, b) => b.activeSeconds - a.activeSeconds);

    return {
        start,
        end,
        inProgress: now < end,
        roles: roles.map((role) => ({
            role,
            hit: sorted.filter((m) => m.activeSeconds >= role.quota_target_seconds),
            missed: sorted.filter((m) => m.activeSeconds < role.quota_target_seconds),
        })),
    };
}
