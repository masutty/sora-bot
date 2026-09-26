import type { BiomeCategory } from "../types";

/** Seeds/XP granted per biome detection, keyed by category - not per individual biome. Global constants for now (same posture as flowers.constants.ts's RARITY_CHANCE). */
export const REWARD_BY_CATEGORY: Record<BiomeCategory, { seeds: number; xp: number }> = {
    weather: { seeds: 1, xp: 2 },
    biome: { seeds: 2, xp: 4 },
    event: { seeds: 3, xp: 6 },
    rare: { seeds: 25, xp: 50 },
};

/** Cumulative XP required to REACH level `n` (n=1 is the starting level, requires 0 XP). Quadratic: early levels come fast, later ones stretch out. Pure/derived - there is no stored `level` column anywhere. */
export function xpForLevel(n: number): number {
    if (n <= 1) return 0;
    return 50 * (n - 1) * (n - 1);
}

/** Derives level + progress-within-level from a raw XP total. */
export function getLevelForXp(xp: number): { level: number; currentLevelXp: number; nextLevelXp: number } {
    let level = 1;
    while (xpForLevel(level + 1) <= xp) level++;
    return { level, currentLevelXp: xpForLevel(level), nextLevelXp: xpForLevel(level + 1) };
}
