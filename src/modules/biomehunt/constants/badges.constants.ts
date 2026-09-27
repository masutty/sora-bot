import type { Badge } from "../types";

interface BadgeMeta {
    /** Lowercase, easy-to-type identifier - used as the wire value for prefix/slash badge options instead of the raw enum key. */
    slug: string;
    emoji: string;
    display: string;
    /** Full sentence shown on the profile embed, e.g. "Found the Glitched biome!" - phrasing varies per badge (found vs. bot-triggered), so it isn't derived from `display`. */
    description: string;
}

export const BADGE_META: Record<Badge, BadgeMeta> = {
    GLITCHED: { slug: "glitched", emoji: "🔥", display: "Glitched", description: "Found the Glitched biome!" },
    CYBERSPACE: { slug: "cyberspace", emoji: "🌐", display: "Cyberspace", description: "Found the Cyberspace biome!" },
    DREAMSPACE: { slug: "dreamspace", emoji: "🌸", display: "Dreamspace", description: "Found the Dreamspace biome!" },
    DELETED: { slug: "deleted", emoji: "💀", display: "Deleted?!", description: "Got auto-deleted for inactivity... and lived to tell the tale." },
};

/** Role-configurable biome badges only. `DELETED` is bot-triggered and display-only - no role can be attached to it. */
export const ALL_BADGES: Badge[] = ["GLITCHED", "CYBERSPACE", "DREAMSPACE"];

/** Resolves a badge's `slug` (the value carried by badge command options) back to its `Badge` key. */
export function resolveBadgeSlug(slug: string): Badge | null {
    const lower = slug.toLowerCase();
    return (Object.keys(BADGE_META) as Badge[]).find((b) => BADGE_META[b].slug === lower) ?? null;
}
