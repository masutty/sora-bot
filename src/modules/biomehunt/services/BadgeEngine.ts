import { Logger } from "@/utils/logging";
import { getGuildBadgeRole, grantUserBadge } from "../repository/badges";
import { enqueueRoleJob } from "../repository/roleJobs";
import { ALL_BADGES, type Badge } from "../types";

const logger = new Logger("biomehunt.BadgeEngine");

const BADGE_SET = new Set<string>(ALL_BADGES);

function isBadgeBiome(biome: string | null): biome is Badge {
    return biome !== null && BADGE_SET.has(biome);
}

/**
 * Awards a badge (and its configured role, if any) the first time a user's macro
 * reports a badge biome. No-op for anything but a confirmed 'started' event, and
 * no-op if the user already holds the badge.
 */
export async function checkAndAwardBadge(
    guildId: string,
    userId: number,
    biome: string | null,
    eventType: "started" | "ended" | null,
): Promise<void> {
    if (eventType !== "started" || !isBadgeBiome(biome)) return;

    const granted = await grantUserBadge(userId, biome);
    if (!granted) return;

    logger.info(`User ${userId} earned badge ${biome} in guild ${guildId}`);

    const roleId = await getGuildBadgeRole(guildId, biome);
    if (roleId) await enqueueRoleJob(guildId, userId, roleId, "add");
}
