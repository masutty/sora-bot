import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import type { ActivityStatus } from "../types";
import { getGuildRoles, getOrCreateGuildConfig } from "../repository/guilds";
import { deleteUserCascade, getUsersForStatusSweep, updateUserStatus } from "../repository/users";
import { enqueueRoleJob } from "../repository/roleJobs";
import { evaluateRollingRewards, runFixedRewardSweep } from "../services/RewardEngine";

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
    await runFixedRewardSweep().catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));

    const users = await getUsersForStatusSweep();
    const now = Date.now();

    for (const user of users) {
        const guildConfig = await getOrCreateGuildConfig(user.guild_id);
        const inactiveSeconds = (now - user.last_activity_at!.getTime()) / 1000;
        const newStatus = resolveStatus(inactiveSeconds, guildConfig.idle_threshold_s, guildConfig.inactive_threshold_s);

        if (newStatus !== user.current_status) {
            await transitionUser(user.id, user.guild_id, newStatus);
        }

        await evaluateRollingRewards(user).catch((err) =>
            logger.error(err instanceof Error ? err : new Error(String(err)), { userId: user.id }),
        );

        const shouldDelete =
            newStatus === "inactive" &&
            guildConfig.delete_inactive_after_s !== null &&
            user.paused_at === null &&
            inactiveSeconds > guildConfig.inactive_threshold_s + guildConfig.delete_inactive_after_s;

        if (shouldDelete) {
            logger.info(`Auto-deleting user ${user.id} (guild ${user.guild_id}) after prolonged inactivity`);
            const deleted = await deleteUserCascade(user.id);
            if (deleted) {
                const channel = await client.channels.fetch(deleted.channelId).catch(() => null);
                if (channel) await channel.delete().catch(() => {});
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
