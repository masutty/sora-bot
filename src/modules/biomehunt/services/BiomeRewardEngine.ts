import { transaction } from "@/database/connection";
import { getUserById } from "../repository/users";
import { grantUserBadge, revokeUserBadge, getGuildBadgeRole } from "../repository/badges";
import { enqueueRoleJob } from "../repository/roleJobs";
import { isFlagEnabled } from "../repository/flags";
import { adjustUserBalance, countRewardsWithBadge, getRewardsByEventIds, insertReward } from "../repository/rewards";
import { ALL_BADGES, BIOME_META, REWARD_BY_CATEGORY, getLevelForXp, type Badge } from "../types";

function isBadgeBiome(biome: string): biome is Badge {
    return (ALL_BADGES as string[]).includes(biome);
}

/**
 * Grants the effects of a single confirmed biome find: the badge (if it's a badge biome and the
 * user doesn't already have it - unconditional, independent of EXPERIMENT_BIOME_ECONOMY) and, only
 * if EXPERIMENT_BIOME_ECONOMY is on for this guild, Seeds/XP per REWARD_BY_CATEGORY. Writes one
 * bh_biome_rewards row iff there's anything to record, so a later revert (see revertBiomeRewards)
 * knows exactly what this specific event granted.
 */
export async function grantBiomeReward(
    guildId: string,
    userId: number,
    eventId: number,
    biome: string,
): Promise<{ seeds: number; xp: number; badge: Badge | null; leveledUp: boolean }> {
    const category = BIOME_META[biome]?.category;
    const economyOn = await isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY");

    let seeds = 0;
    let xp = 0;
    if (economyOn && category) {
        seeds = REWARD_BY_CATEGORY[category].seeds;
        xp = REWARD_BY_CATEGORY[category].xp;
    }

    let badge: Badge | null = null;
    if (isBadgeBiome(biome)) {
        const granted = await grantUserBadge(userId, biome);
        if (granted) badge = biome;
    }

    if (seeds === 0 && xp === 0 && !badge) {
        return { seeds: 0, xp: 0, badge: null, leveledUp: false };
    }

    const userBefore = await getUserById(userId);
    const levelBefore = userBefore ? getLevelForXp(userBefore.xp).level : 1;

    await transaction(async (client) => {
        await insertReward(client, { eventId, userId, biome, seeds, xp, badge });
        if (seeds !== 0 || xp !== 0) await adjustUserBalance(client, userId, seeds, xp);
    });

    if (badge) {
        const roleId = await getGuildBadgeRole(guildId, badge);
        if (roleId) await enqueueRoleJob(guildId, userId, roleId, "add");
    }

    const userAfter = await getUserById(userId);
    const levelAfter = userAfter ? getLevelForXp(userAfter.xp).level : levelBefore;

    return { seeds, xp, badge, leveledUp: levelAfter > levelBefore };
}

/**
 * Reverses whatever grantBiomeReward granted for a set of events that are about to be deleted
 * (an admin correcting fake reports). Must be called BEFORE the events are actually deleted - it
 * reads the ledger and applies the Seeds/XP reversal here, but returns the set of badges that MIGHT
 * now need revoking (`badgeCandidates`) rather than revoking them itself: that check can only run
 * correctly AFTER the caller deletes the events (which cascades the ledger rows away) - see
 * `revokeOrphanedBadges` below and its call sites in `adminMemberActions.ts`.
 */
export async function revertBiomeRewards(
    userId: number,
    eventIds: number[],
): Promise<{ seedsReverted: number; xpReverted: number; badgeCandidates: Badge[] }> {
    if (eventIds.length === 0) return { seedsReverted: 0, xpReverted: 0, badgeCandidates: [] };

    const rewards = await getRewardsByEventIds(eventIds);
    if (rewards.length === 0) return { seedsReverted: 0, xpReverted: 0, badgeCandidates: [] };

    const seedsReverted = rewards.reduce((sum, r) => sum + r.seeds_awarded, 0);
    const xpReverted = rewards.reduce((sum, r) => sum + r.xp_awarded, 0);
    const badgeCandidates = [...new Set(rewards.map((r) => r.badge_awarded).filter((b): b is Badge => b !== null))];

    if (seedsReverted !== 0 || xpReverted !== 0) {
        await adjustUserBalance(null, userId, -seedsReverted, -xpReverted);
    }

    return { seedsReverted, xpReverted, badgeCandidates };
}

/**
 * Second half of a revert: call this AFTER the caller has already deleted the events (so any
 * ledger rows they granted are already gone via cascade), passing `revertBiomeRewards`'s
 * `badgeCandidates`. Revokes each one that no longer has ANY surviving ledger grant.
 */
export async function revokeOrphanedBadges(guildId: string, userId: number, candidateBadges: Badge[]): Promise<Badge[]> {
    const revoked: Badge[] = [];
    for (const badge of candidateBadges) {
        const remaining = await countRewardsWithBadge(userId, badge);
        if (remaining > 0) continue;
        const wasRevoked = await revokeUserBadge(userId, badge);
        if (!wasRevoked) continue;
        revoked.push(badge);
        const roleId = await getGuildBadgeRole(guildId, badge);
        if (roleId) await enqueueRoleJob(guildId, userId, roleId, "remove");
    }
    return revoked;
}
