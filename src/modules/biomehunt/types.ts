export type ActivityStatus = "active" | "idle" | "inactive";

/** Hardcoded biome grouping, used to quick-select "all biomes in category X" wherever biomes are configured. */
export type BiomeCategory = "biome" | "weather" | "rare" | "event";

export type RoleJobAction = "add" | "remove";
export type QuotaRoleMode = "F" | "RW";

export type Badge = "GLITCHED" | "CYBERSPACE" | "DREAMSPACE" | "DELETED";

export type FlagName =
    | "REPORT_SESSION_ON_END" | "PING_ON_QUOTA_MET" | "CLEAR_PROFILE_ON_AUTODELETE" | "AUTO_DELETE_ENABLED"
    | "EXPERIMENT_WEBHOOK_FLOWERS" | "EXPERIMENT_BIOME_ECONOMY";

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
    seeds: number;
    xp: number;
    /** Sticks to the user, not the macro channel - survives soft-delete/reset-channel. Only
     * `/bh reroll` and `/bh-owner reroll-flower` are allowed to change it once set. */
    flower: string | null;
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

export interface BiomeRewardRow {
    event_id: number;
    user_id: number;
    biome: string;
    seeds_awarded: number;
    xp_awarded: number;
    badge_awarded: Badge | null;
    awarded_at: Date;
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
    userId: number;
    eventId: number;
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
