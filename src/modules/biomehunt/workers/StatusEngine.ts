import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import type { ActivityStatus } from "../types";
import { grantUserBadge } from "../repository/badges";
import { isFlagEnabled } from "../repository/flags";
import { getGuildRoles, getOrCreateGuildConfig } from "../repository/guilds";
import {
    deleteMacroChannelOnly, deleteUserCascade, getUsersForStatusSweep, resetActivityState, updateUserStatus,
} from "../repository/users";
import { enqueueRoleJob } from "../repository/roleJobs";
import { evaluateRollingRewards, runFixedRewardSweep } from "../services/RewardEngine";
import { reportSessionEnd } from "../services/SessionReportEngine";

const logger = new Logger("biomehunt.StatusEngine");

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

const TICK_INTERVAL_MS = 30_000;

function resolveStatus(inactiveSeconds: number, idleThresholdS: number, inactiveThresholdS: number): ActivityStatus {
    if (inactiveSeconds < idleThresholdS) return "active";
    if (inactiveSeconds < inactiveThresholdS) return "idle";
    return "inactive";
}

async function tick(client: BotClient): Promise<void> {
    await runFixedRewardSweep(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));

    const users = await getUsersForStatusSweep();
    const now = Date.now();

    for (const user of users) {
        const guildConfig = await getOrCreateGuildConfig(user.guild_id);
        const inactiveSeconds = (now - user.last_activity_at!.getTime()) / 1000;
        const newStatus = resolveStatus(inactiveSeconds, guildConfig.idle_threshold_s, guildConfig.inactive_threshold_s);
        const wasActive = user.current_status === "active";

        if (newStatus !== user.current_status) {
            await transitionUser(user.id, user.guild_id, newStatus);

            if (wasActive && newStatus !== "active" && await isFlagEnabled(user.guild_id, "REPORT_SESSION_ON_END")) {
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
            inactiveSeconds > guildConfig.inactive_threshold_s + guildConfig.delete_inactive_after_s &&
            await isFlagEnabled(user.guild_id, "AUTO_DELETE_ENABLED");

        if (shouldDelete) {
            const hardWipe = await isFlagEnabled(user.guild_id, "CLEAR_PROFILE_ON_AUTODELETE");
            const deleted = hardWipe ? await deleteUserCascade(user.id) : await deleteMacroChannelOnly(user.id);

            // `deleted` is null once there's nothing left to remove (already handled on a prior tick,
            // or a hard-wiped row is simply gone) - skip side effects so this doesn't repeat forever.
            if (deleted) {
                logger.info(`Auto-deleting user ${user.id} (guild ${user.guild_id}) after prolonged inactivity (${hardWipe ? "full wipe" : "channel only"})`);
                const channel = await client.channels.fetch(deleted.channelId).catch(() => null);
                if (channel) await channel.delete().catch(() => {});
                if (!hardWipe) {
                    await grantUserBadge(user.id, "DELETED");
                    await resetActivityState(user.id);
                }
            }
        }
    }
}

export function startStatusEngine(client: BotClient): void {
    setInterval(() => {
        tick(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
    }, TICK_INTERVAL_MS);
    logger.info(`Status engine started (tick every ${TICK_INTERVAL_MS}ms)`);
}
