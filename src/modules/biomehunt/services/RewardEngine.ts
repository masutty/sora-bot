import { Logger } from "@/utils/logging";
import { getActiveSecondsInWindow } from "../repository/activity";
import { getGuildsDueForFixedRewardEval, markQuotaEvaluated } from "../repository/guilds";
import {
    getQuotaRolesByMode, getUserQuotaRole, grantQuotaRole, revokeQuotaRole,
} from "../repository/quotaRoles";
import { enqueueRoleJob, scheduleRoleRemoval } from "../repository/roleJobs";
import { getUsersForGuild } from "../repository/users";
import type { QuotaRoleRow, UserRow } from "../types";

const logger = new Logger("biomehunt.RewardEngine");

/**
 * RW-mode: continuous reactive check. Called once per user per Status Engine
 * tick (same 30s cadence, same per-user loop) — grants/revokes immediately on
 * a compliance state change, no-ops otherwise so it never spams the role queue.
 */
export async function evaluateRollingRewards(user: UserRow): Promise<void> {
    const roles = await getQuotaRolesByMode(user.guild_id, "RW");
    for (const role of roles) {
        await evaluateRollingReward(user, role);
    }
}

async function evaluateRollingReward(user: UserRow, role: QuotaRoleRow): Promise<void> {
    const activeSeconds = await getActiveSecondsInWindow(user.id, role.quota_window_hours);
    const compliant = activeSeconds >= role.quota_target_seconds;
    const held = await getUserQuotaRole(user.id, role.id);

    if (compliant && !held) {
        await grantQuotaRole(user.id, role.id, null);
        await enqueueRoleJob(user.guild_id, user.id, role.role_id, "add");
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
async function evaluateFixedRewardsForGuild(guildId: string): Promise<void> {
    const roles = await getQuotaRolesByMode(guildId, "F");
    if (roles.length === 0) return;

    const users = await getUsersForGuild(guildId);

    for (const user of users) {
        for (const role of roles) {
            const activeSeconds = await getActiveSecondsInWindow(user.id, role.quota_window_hours);
            if (activeSeconds < role.quota_target_seconds) continue;

            const held = await getUserQuotaRole(user.id, role.id);
            const expiresAt = new Date(Date.now() + role.access_duration_days! * 86_400_000);

            await grantQuotaRole(user.id, role.id, expiresAt);
            if (!held) await enqueueRoleJob(guildId, user.id, role.role_id, "add");
            await scheduleRoleRemoval(guildId, user.id, role.role_id, expiresAt);
        }
    }
}

/** Runs the F-mode daily sweep for every guild that's currently due for it. Call once per Status Engine tick. */
export async function runFixedRewardSweep(): Promise<void> {
    const dueGuilds = await getGuildsDueForFixedRewardEval();
    for (const guild of dueGuilds) {
        try {
            await evaluateFixedRewardsForGuild(guild.guild_id);
            await markQuotaEvaluated(guild.guild_id);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: guild.guild_id });
        }
    }
}
