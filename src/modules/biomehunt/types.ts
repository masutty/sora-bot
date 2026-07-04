export type ActivityStatus = "active" | "idle" | "inactive";
export type RoleJobAction = "add" | "remove";
export type QuotaRoleMode = "F" | "RW";

/**
 * Thrown for expected, user-facing failures (bad input, missing config, etc).
 * Command handlers show its message verbatim instead of the generic failure quip.
 */
export class BiomeHuntError extends Error {}

export interface GuildConfigRow {
    guild_id: string;
    quota_window_hours: number;
    quota_target_seconds: number;
    session_gap_threshold_s: number;
    idle_threshold_s: number;
    inactive_threshold_s: number;
    auto_create_categories: boolean;
    delete_inactive_after_s: number | null;
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
}
