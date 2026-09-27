import { UserFacingError } from "@/define";

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
export class BiomeHuntError extends UserFacingError {}

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

/**
 * A rare-biome forward's community vote (`bh_biome_votes`). `OPEN` is the only non-final state -
 * every other value is terminal for the community, though an admin can still override one later
 * via `/bh-admin review`, re-editing the forward message again with the new outcome.
 * `NO_VOTES` and `TIE` are distinct: 0×0 is "no votes", not a tie - a tie requires at least one
 * vote on each side.
 */
export enum VoteStatus {
    OPEN = "open",
    NO_VOTES = "no_votes",
    TIE = "tie",
    COMMUNITY_REAL = "community_real",
    COMMUNITY_FAKE = "community_fake",
    ADMIN_CONFIRMED = "admin_confirmed",
    ADMIN_DENIED = "admin_denied",
}

/** A single ballot's choice (`bh_biome_vote_ballots.choice`) - also doubles as an admin's decisive click. */
export enum VoteChoice {
    REAL = "real",
    FAKE = "fake",
}

export interface BiomeVoteRow {
    /** Short random code (like a trace `ref`) - shown on the message, never sequential/guessable. */
    id: string;
    guild_id: string;
    /** `null` once an admin denies (the event is deleted, ON DELETE SET NULL) - the vote/ballots survive; `applyOutcome` skips any grant/revert once this is null. */
    event_id: number | null;
    /** `bh_users.id` of the finder - the one Discord account barred from voting (or deciding, as an admin) on their own find. */
    finder_user_id: number;
    /** The forward/vote message's own identity - needed to fetch and re-edit it after a restart. */
    channel_id: string;
    message_id: string;
    biome: string;
    /** The forward message's own render inputs, captured at open time - never re-derived later (a forward config can change mid-vote; the macro's server link isn't stored anywhere else). */
    role_id: string | null;
    server_link: string | null;
    jump_link: string;
    find_count: number | null;
    status: VoteStatus;
    /** Discord id of the deciding admin - set only for admin_confirmed/admin_denied. */
    decided_by: string | null;
    closes_at: Date;
    created_at: Date;
    decided_at: Date | null;
}

export interface BiomeVoteBallotRow {
    vote_id: string;
    /** Raw Discord user id (not `bh_users.id`) - a voter need not have a BiomeHunt profile. */
    user_id: string;
    choice: VoteChoice;
    created_at: Date;
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
