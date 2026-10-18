import type { BotClient } from "@/core/bot-client";
import { getPoolStats } from "@/database/connection";
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import { recordTickStats } from "@/utils/metrics";
import { grantUserBadge } from "../repository/badges.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getGuildRoles, getOrCreateGuildConfig } from "../repository/guilds.repository";
import { enqueueRoleJob } from "../repository/role-jobs.repository";
import {
    deleteMacroChannelOnly,
    deleteUserCascade,
    getUsersForStatusSweep,
    resetActivityState,
    updateUserStatus,
} from "../repository/users.repository";
import { effectiveLastActivity } from "../services/activity-grace.service";
import { reportSessionEnd } from "../services/activity-session-report.service";
import { evaluateRollingRewards, runFixedRewardSweep } from "../services/reward.service";
import { settings } from "../settings";
import type { ActivityStatus } from "../types";

const logger = new Logger("biomehunt.workers.status");

/** True once a member has been inactive for the full delete delay, counted from the end of their last session. */
export function shouldAutoDelete(secondsSinceSessionEnd: number, inactiveS: number, deleteAfterS: number): boolean {
    return secondsSinceSessionEnd > inactiveS + deleteAfterS;
}

export async function transitionUser(userId: number, guildId: string, newStatus: ActivityStatus): Promise<void> {
    await updateUserStatus(userId, newStatus);

    const roles = await getGuildRoles(guildId);
    const roleForStatus: Record<ActivityStatus, string | null> = {
        active: roles.active,
        idle: roles.idle,
        inactive: roles.inactive,
    };

    const addRoleId = roleForStatus[newStatus];
    if (addRoleId) await enqueueRoleJob(guildId, userId, addRoleId, "add");

    for (const status of Object.keys(roleForStatus) as ActivityStatus[]) {
        if (status === newStatus) continue;
        const removeRoleId = roleForStatus[status];
        if (removeRoleId) await enqueueRoleJob(guildId, userId, removeRoleId, "remove");
    }
}

/** Idle and inactive thresholds count from the end of the session: last activity plus the session gap. */
export function resolveStatus(
    secondsSinceLastActivity: number,
    sessionGapS: number,
    idleThresholdS: number,
    inactiveThresholdS: number,
): ActivityStatus {
    const secondsSinceSessionEnd = secondsSinceLastActivity - sessionGapS;
    if (secondsSinceSessionEnd < idleThresholdS) return "active";
    if (secondsSinceSessionEnd < inactiveThresholdS) return "idle";
    return "inactive";
}

async function tick(client: BotClient): Promise<void> {
    const tickStart = Date.now();

    await runFixedRewardSweep(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));

    const users = await getUsersForStatusSweep();
    const now = Date.now();

    for (const user of users) {
        // Bot isn't (or isn't yet) in this guild - skip entirely rather than doing pointless work
        // (status transitions, quota checks, role job enqueuing) for a guild it can't act in.
        if (!client.guilds.cache.has(user.guild_id)) continue;

        // Never null here (`getUsersForStatusSweep` filters it out) - narrows the type.
        if (!user.last_activity_at) continue;

        const guildConfig = await getOrCreateGuildConfig(user.guild_id);
        // A running timed biome keeps the user active; afterwards the idle threshold counts from its expected end.
        const lastActivity = effectiveLastActivity(user.last_activity_at, user.activity_grace_until) ?? user.last_activity_at;
        const secondsSinceLastActivity = (now - lastActivity.getTime()) / 1000;
        const secondsSinceSessionEnd = secondsSinceLastActivity - guildConfig.session_gap_threshold_s;
        const newStatus = resolveStatus(
            secondsSinceLastActivity,
            guildConfig.session_gap_threshold_s,
            guildConfig.idle_threshold_s,
            guildConfig.inactive_threshold_s,
        );
        const wasActive = user.current_status === "active";

        if (newStatus !== user.current_status) {
            await transitionUser(user.id, user.guild_id, newStatus);

            if (wasActive && newStatus !== "active" && (await isFlagEnabled(user.guild_id, "REPORT_SESSION_ON_END"))) {
                await reportSessionEnd(client, user.id).catch((err) =>
                    logger.error(err instanceof Error ? err : new Error(String(err)), { userId: user.id }),
                );
            }
        }

        await evaluateRollingRewards(client, user).catch((err) =>
            logger.error(err instanceof Error ? err : new Error(String(err)), { userId: user.id }),
        );

        const shouldDelete =
            newStatus === "inactive" &&
            user.paused_at === null &&
            shouldAutoDelete(secondsSinceSessionEnd, guildConfig.inactive_threshold_s, guildConfig.delete_inactive_after_s) &&
            (await isFlagEnabled(user.guild_id, "AUTO_DELETE_ENABLED"));

        if (shouldDelete) {
            const hardWipe = await isFlagEnabled(user.guild_id, "CLEAR_PROFILE_ON_AUTODELETE");
            const deleted = hardWipe ? await deleteUserCascade(user.id) : await deleteMacroChannelOnly(user.id);

            // `deleted` is null once there's nothing left to remove (already handled on a prior tick,
            // or a hard-wiped row is simply gone) - skip side effects so this doesn't repeat forever.
            if (deleted) {
                logger.info(
                    `Auto-deleting user ${user.id} (guild ${user.guild_id}) after prolonged inactivity (${hardWipe ? "full wipe" : "channel only"})`,
                );
                const channel = await client.channels.fetch(deleted.channelId).catch(() => null);
                if (channel) await channel.delete().catch(() => {});
                if (!hardWipe) {
                    await grantUserBadge(user.id, "DELETED");
                    await resetActivityState(user.id);
                }
            }
        }
    }

    recordTickStats(Date.now() - tickStart, users.length);

    const poolStats = getPoolStats();
    if (poolStats.waiting > 0) {
        logger.warn(`DB pool has ${poolStats.waiting} client(s) waiting for a connection - consider raising DB_POOL_MAX`, poolStats);
    }
}

export const statusWorker = defineWorker({
    name: "status",
    intervalMs: settings.workers.statusTickMs,
    run: tick,
});
