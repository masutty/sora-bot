import type { Badge } from "../types";
import { formatBiomeName, getAllBiomes, getBiomeMeta } from "./biomes.constants";

export interface BadgeMeta {
    /** Lowercase, easy-to-type identifier - used as the wire value for prefix/slash badge options instead of the raw key. */
    slug: string;
    emoji: string;
    display: string;
    /** Full sentence shown on the profile embed, e.g. "Found the Glitched biome!". */
    description: string;
}

/** The one bot-triggered badge - given on an auto-delete for inactivity, never by a biome. */
export const DELETED_BADGE: Badge = "DELETED";

/** A biome badge's emoji when its biome sets none (`BiomeMeta.badgeEmoji`). */
export const DEFAULT_BADGE_EMOJI = "🏅";

/**
 * Given once a member has found every rare biome - every Infinity Stone. Kept for good: a rare biome
 * added later doesn't take it away. Its key can't collide with a biome (biome keys have no "_").
 */
export const INFINITY_BADGE: Badge = "INFINITY_GAUNTLET";

/** A badge emoji for plain text (channel names, select labels) - a custom `<:name:id>` emoji doesn't render or round-trip there, so it falls back to the default. */
export function plainBadgeEmoji(emoji: string | null | undefined): string {
    return !emoji || /^<a?:/.test(emoji) ? DEFAULT_BADGE_EMOJI : emoji;
}

const DELETED_META: BadgeMeta = {
    slug: "deleted",
    emoji: "💀",
    display: "Deleted?!",
    description: "Got auto-deleted for inactivity... and lived to tell the tale.",
};

const INFINITY_META: BadgeMeta = {
    slug: "infinity_gauntlet",
    emoji: "💎",
    display: "Infinity Gauntlet",
    description: "Found every rare biome - every stone in the gauntlet. Inevitable.",
};

/**
 * How a badge displays. Every badge but `DELETED` and `INFINITY_GAUNTLET` is a biome's biome badge, keyed by the biome:
 * its label, its `badgeEmoji`, "Found the <label> biome!". Read from the live biome registry, so a
 * badge earned before its biome's badge was turned off still shows.
 */
export function getBadgeMeta(badge: Badge): BadgeMeta {
    if (badge === DELETED_BADGE) return DELETED_META;
    if (badge === INFINITY_BADGE) return INFINITY_META;
    const display = formatBiomeName(badge);
    return {
        slug: badge.toLowerCase(),
        emoji: getBiomeMeta(badge)?.badgeEmoji || DEFAULT_BADGE_EMOJI,
        display,
        description: `Found the ${display} biome!`,
    };
}

/** Whether finding this biome earns its biome badge. */
export function biomeHasBadge(biome: string): boolean {
    return getBiomeMeta(biome)?.hasBadge === true;
}

/** Every biome badge currently given (enabled biomes with `hasBadge`) - the ones a guild can attach a role to. */
export function getBiomeBadges(): Badge[] {
    return getAllBiomes()
        .filter((e) => e.enabled && e.hasBadge)
        .map((e) => e.key);
}

/** Every badge a guild can attach a role to - the biome badges plus the Infinity Gauntlet. */
export function getRoleBadges(): Badge[] {
    return [...getBiomeBadges(), INFINITY_BADGE];
}

/** Every badge an admin can award or take by hand - the role badges plus `DELETED`. */
export function getAwardableBadges(): Badge[] {
    return [...getRoleBadges(), DELETED_BADGE];
}

/**
 * Resolves a badge's `slug` (the value carried by badge command options) back to its key. Any
 * registered biome resolves, not only current biome badges - so a badge earned before its biome's
 * badge was turned off can still be taken away.
 */
export function resolveBadgeSlug(slug: string): Badge | null {
    const key = slug.trim().toUpperCase();
    return key === DELETED_BADGE || key === INFINITY_BADGE || getBiomeMeta(key) ? key : null;
}
