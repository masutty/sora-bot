export type ActivityStatus = "active" | "idle" | "inactive";

/** Hardcoded biome grouping, used to quick-select "all biomes in category X" wherever biomes are configured. */
export type BiomeCategory = "biome" | "weather" | "rare" | "event";

export const ALL_BIOME_CATEGORIES: BiomeCategory[] = ["biome", "weather", "rare", "event"];

export const BIOME_CATEGORY_LABELS: Record<BiomeCategory, string> = {
    biome: "Biome",
    weather: "Weather",
    rare: "Rare",
    event: "Event",
};

interface BiomeMeta {
    label: string;
    category: BiomeCategory;
    color: number;
    /** Optional icon shown next to the biome name on its forward notification. Unset = no image. */
    iconUrl?: string;
}

/**
 * SINGLE SOURCE OF TRUTH for every recognized biome, keyed by its canonical space-less
 * uppercase form (how it's stored/matched - see `normalizeBiomeName` in webhookParser.ts).
 * To add/rename/recolor/recategorize/reicon a biome, edit it here - everything else
 * (recognition, display name, category grouping, forward notification color/icon) reads
 * from this one object. Anything not listed here falls back to a generic Title Case
 * display name, no category match, the default accent color, and no icon.
 */
export const BIOME_META: Record<string, BiomeMeta> = {
    WINDY: { label: "Windy", category: "weather", color: 0xa9dfff, iconUrl: "https://i.imgur.com/GD9ppHZ.png" },
    SNOWY: { label: "Snowy", category: "weather", color: 0xdfffff, iconUrl: "https://i.imgur.com/8rXSIQ0.png" },
    RAINY: { label: "Rainy", category: "weather", color: 0x3a6ea5, iconUrl: "https://i.imgur.com/KYblZp4.png" },
    SANDSTORM: { label: "Sand Storm", category: "biome", color: 0xe0c068, iconUrl: "https://i.imgur.com/gBJQViw.png" },
    HELL: { label: "Hell", category: "biome", color: 0xd7263d, iconUrl: "https://i.imgur.com/qf4ih2k.png" },
    STARFALL: { label: "Starfall", category: "biome", color: 0x6c5ce7, iconUrl: "https://i.imgur.com/KDlFLf3.png" },
    HEAVEN: { label: "Heaven", category: "biome", color: 0xffd700, iconUrl: "https://i.imgur.com/y6OXzVv.png" },
    CORRUPTION: { label: "Corruption", category: "biome", color: 0x4b0082, iconUrl: "https://i.imgur.com/lzlsuC6.png" },
    NULL: { label: "Null", category: "biome", color: 0x2c2f33, iconUrl: "https://i.imgur.com/krutokU.png" },
    GLITCHED: { label: "Glitched", category: "rare", color: 0xff00ff, iconUrl: "https://i.imgur.com/xTd6Ku4.png" },
    CYBERSPACE: { label: "Cyberspace", category: "rare", color: 0x00e5ff, iconUrl: "https://i.imgur.com/FxFEobX.png" },
    DREAMSPACE: { label: "Dreamspace", category: "rare", color: 0xffb6d9, iconUrl: "https://i.imgur.com/JCoQDvY.png" },
    SINGULARITY: { label: "Singularity", category: "rare", color: 0x0a0a0a, iconUrl: "https://i.imgur.com/rBoV7lJ.png" },
    PUMPKINMOON: { label: "Pumpkin Moon", category: "event", color: 0xff8c00, iconUrl: "https://i.imgur.com/wEdcqqI.png" },
    GRAVEYARD: { label: "Graveyard", category: "event", color: 0x556b2f, iconUrl: "https://i.imgur.com/MrKZqUx.png" },
    BLAZINGSUN: { label: "Blazing Sun", category: "event", color: 0xff4500, iconUrl: "https://i.imgur.com/BMKWWJ3.png" },
    BLOODRAIN: { label: "Blood Rain", category: "event", color: 0x8b0000, iconUrl: "https://i.imgur.com/w8oVQ8e.png" },
    AURORA: { label: "Aurora", category: "event", color: 0x00fa9a, iconUrl: "https://i.imgur.com/nS7GTo1.png" },
    EGGLAND: { label: "Eggland", category: "event", color: 0xf5deb3, iconUrl: "https://i.imgur.com/vkQwGrz.png" },
};

export function getBiomeIconUrl(biome: string): string | undefined {
    return BIOME_META[biome]?.iconUrl;
}

export function formatBiomeName(biome: string): string {
    const known = BIOME_META[biome]?.label;
    if (known) return known;
    return biome.charAt(0) + biome.slice(1).toLowerCase();
}

export function getBiomesByCategory(category: BiomeCategory): string[] {
    return Object.entries(BIOME_META).filter(([, meta]) => meta.category === category).map(([biome]) => biome);
}

/**
 * Resolves a biome selector - either one concrete biome key, `CAT:<category>` for every biome
 * in that category, or `ALL` for every known biome - into the list of concrete biome keys it
 * targets. Used wherever an admin can quick-apply a forward to a whole group at once.
 */
export function resolveBiomeSelector(selector: string): string[] {
    if (selector === "ALL") return Object.keys(BIOME_META);
    if (selector.startsWith("CAT:")) return getBiomesByCategory(selector.slice(4) as BiomeCategory);
    if (!(selector in BIOME_META)) throw new BiomeHuntError(`Unknown biome: ${selector}`);
    return [selector];
}

/** Ready-made choice list (quick categories first, then every individual biome) for biome selectors in UI. */
export const BIOME_SELECTOR_CHOICES: Array<{ name: string; value: string }> = [
    { name: "All", value: "ALL" },
    ...ALL_BIOME_CATEGORIES.map((category) => ({ name: `All ${BIOME_CATEGORY_LABELS[category]}`, value: `CAT:${category}` })),
    ...Object.entries(BIOME_META).map(([value, meta]) => ({ name: meta.label, value })),
];

/** Individual biomes only (no ALL/category shortcuts) - used where a single concrete biome is required, e.g. correcting one user's find count. */
export const BIOME_ONLY_CHOICES: Array<{ name: string; value: string }> = Object.entries(BIOME_META).map(([value, meta]) => ({ name: meta.label, value }));

const DEFAULT_BIOME_COLOR = 0x5865f2;

export function getBiomeColor(biome: string): number {
    return BIOME_META[biome]?.color ?? DEFAULT_BIOME_COLOR;
}
export type RoleJobAction = "add" | "remove";
export type QuotaRoleMode = "F" | "RW";

export type Badge = "GLITCHED" | "CYBERSPACE" | "DREAMSPACE" | "DELETED";

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

export type FlagName = "REPORT_SESSION_ON_END" | "PING_ON_QUOTA_MET" | "CLEAR_PROFILE_ON_AUTODELETE" | "AUTO_DELETE_ENABLED";

/** SINGLE SOURCE OF TRUTH for every guild feature flag - `flag list` reads name/description/default straight from here. */
export const FLAG_DEFINITIONS: Record<FlagName, { label: string; description: string; default: boolean }> = {
    REPORT_SESSION_ON_END: {
        label: "Report Session On End",
        description: "Post a session summary (duration + biome breakdown) to a user's macro channel when their session ends.",
        default: false,
    },
    PING_ON_QUOTA_MET: {
        label: "Ping On Quota Met",
        description: "Post a notification to a user's macro channel the moment they freshly meet a quota role's requirement.",
        default: false,
    },
    CLEAR_PROFILE_ON_AUTODELETE: {
        label: "Clear Profile On Autodelete",
        description: "ON: inactivity auto-delete fully wipes the user's data. OFF (default): auto-delete only removes their macro channel, keeping history/badges/quota status, and awards the 'Deleted?!' badge.",
        default: false,
    },
    AUTO_DELETE_ENABLED: {
        label: "Auto Delete Enabled",
        description: "Whether inactive users' macro channels get auto-deleted at all. The number of hours after going inactive is set separately via `activity delete`.",
        default: false,
    },
};

export const ALL_FLAGS: FlagName[] = Object.keys(FLAG_DEFINITIONS) as FlagName[];

/**
 * Thrown for expected, user-facing failures (bad input, missing config, etc).
 * Command handlers show its message verbatim instead of the generic failure quip.
 */
export class BiomeHuntError extends Error {}

export interface GuildConfigRow {
    guild_id: string;
    session_gap_threshold_s: number;
    idle_threshold_s: number;
    inactive_threshold_s: number;
    auto_create_categories: boolean;
    /** Hours-after-inactive threshold (in seconds) for auto-delete - always set; whether it's actually acted on is gated by the AUTO_DELETE_ENABLED flag, not by this being null. */
    delete_inactive_after_s: number;
    counter_channel_id: string | null;
    counter_message_id: string | null;
    quota_eval_hour_utc: number;
    quota_last_evaluated_date: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface GuildCategoryRow {
    id: number;
    guild_id: string;
    discord_category_id: string;
    is_enabled: boolean;
}

export interface GuildRolesConfig {
    active: string | null;
    idle: string | null;
    inactive: string | null;
}

export interface UserRow {
    id: number;
    guild_id: string;
    discord_user_id: string;
    current_status: ActivityStatus;
    last_activity_at: Date | null;
    paused_at: Date | null;
    created_at: Date;
}

export interface UserMacroChannelRow {
    id: number;
    user_id: number;
    channel_id: string;
    webhook_id: string;
    webhook_url: string;
    created_at: Date;
}

export interface ActivityEventRow {
    id: number;
    user_id: number;
    discord_message_id: string;
    biome: string | null;
    macro_type: string | null;
    event_type: "started" | "ended" | null;
    event_timestamp: Date | null;
    received_at: Date;
}

export interface ActivitySessionRow {
    id: number;
    user_id: number;
    started_at: Date;
    ended_at: Date;
    duration_seconds: number;
}

export interface QuotaRoleRow {
    id: number;
    guild_id: string;
    role_id: string;
    mode: QuotaRoleMode;
    quota_target_seconds: number;
    quota_window_hours: number;
    access_duration_days: number | null;
    created_at: Date;
    updated_at: Date;
}

export interface UserQuotaRoleRow {
    user_id: number;
    quota_role_id: number;
    granted_at: Date;
    expires_at: Date | null;
}

export interface GuildBadgeRoleRow {
    guild_id: string;
    badge: Badge;
    role_id: string;
}

export interface UserBadgeRow {
    user_id: number;
    badge: Badge;
    awarded_at: Date;
}

export interface BiomeForwardRow {
    guild_id: string;
    biome: string;
    channel_id: string;
    role_id: string | null;
}

export type VoteCheckStatus = "pending" | "confirmed" | "denied";
export type VoteCheckDecidedBy = "admin" | null;

/** In-memory only - doesn't need to survive a restart, the admin-decision buttons only need to work for as long as this process is alive. */
export interface VoteCheckState {
    /** The forward/vote message's own identity - needed to fetch and edit it, NOT for the jump link (see originalJumpLink). */
    messageId: string;
    guildId: string;
    channelId: string;
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    /** Jump link to the ORIGINAL webhook message that triggered this forward - fixed at creation, never recomputed from the forward message's own identity. */
    originalJumpLink: string;
    status: VoteCheckStatus;
    decidedBy: VoteCheckDecidedBy;
    decidedByUserId: string | null;
}

export interface RoleJobRow {
    id: number;
    guild_id: string;
    user_id: number;
    role_id: string;
    action: RoleJobAction;
    retry_count: number;
    execute_after: Date;
    processed: boolean;
    created_at: Date;
}

export interface ParsedEvent {
    biome: string | null;
    macroType: string | null;
    eventType: "started" | "ended" | null;
    eventTimestamp: Date | null;
    serverLink: string | null;
}
