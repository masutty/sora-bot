import { transaction } from "@/database/connection";
import { getUserById } from "../repository/users";
import { grantUserBadge, revokeUserBadge, getGuildBadgeRole } from "../repository/badges";
import { enqueueRoleJob } from "../repository/roleJobs";
import { isFlagEnabled } from "../repository/flags";
import {
    adjustUserBalance, countRewardsWithBadge, getRewardsByEventIds, getUnrewardedEventsForUser, insertReward,
} from "../repository/rewards";
import { ALL_BADGES, BIOME_META, REWARD_BY_CATEGORY, getLevelForXp, type Badge, type UserRow } from "../types";

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

export interface RewardBackfillFilters {
    /** `null` = no restriction on that axis. */
    afterDate: Date | null;
    biomes: string[] | null;
}

export interface RewardBackfillPlan {
    events: Array<{ id: number; biome: string; seeds: number; xp: number }>;
    totalSeeds: number;
    totalXp: number;
    /** Confirmed events matching the filters whose biome isn't in BIOME_META (no category -> no
     * reward value to compute) - reported so `bh-owner recalculate-user` can surface them instead
     * of silently doing nothing for them. */
    skippedUnknownCount: number;
}

/**
 * Computes (without writing anything) what an ADDITIVE Seeds/XP backfill would grant: every
 * confirmed (`started`, non-null biome) event this user has that doesn't already have a
 * `bh_biome_rewards` row, optionally narrowed by date/biome. Deliberately does NOT check
 * `EXPERIMENT_BIOME_ECONOMY` - this is an explicit bot-owner correction tool, not the live
 * detection path, and needs to work even for a guild that has the economy turned off (e.g. to
 * pre-credit history before turning it on). Badges are out of scope here entirely.
 */
export async function planUserRewardBackfill(userId: number, filters: RewardBackfillFilters): Promise<RewardBackfillPlan> {
    const candidates = await getUnrewardedEventsForUser(userId, filters.afterDate, filters.biomes);

    const events: RewardBackfillPlan["events"] = [];
    let totalSeeds = 0;
    let totalXp = 0;
    let skippedUnknownCount = 0;

    for (const c of candidates) {
        const category = BIOME_META[c.biome]?.category;
        if (!category) {
            skippedUnknownCount++;
            continue;
        }
        const { seeds, xp } = REWARD_BY_CATEGORY[category];
        events.push({ id: c.id, biome: c.biome, seeds, xp });
        totalSeeds += seeds;
        totalXp += xp;
    }

    return { events, totalSeeds, totalXp, skippedUnknownCount };
}

/** Writes exactly the plan a prior `planUserRewardBackfill` call computed - one ledger row per event plus a single aggregate balance update, all in one transaction. */
export async function applyUserRewardBackfill(userId: number, plan: RewardBackfillPlan): Promise<UserRow> {
    return transaction(async (client) => {
        for (const e of plan.events) {
            await insertReward(client, { eventId: e.id, userId, biome: e.biome, seeds: e.seeds, xp: e.xp, badge: null });
        }
        return adjustUserBalance(client, userId, plan.totalSeeds, plan.totalXp);
    });
}
