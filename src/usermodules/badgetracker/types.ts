import { UserFacingError } from "@/define";

/** `awarded_count` is BIGINT, which pg returns as a string - convert with `Number()` at use sites. */
export interface BadgeRow {
    badge_id: string;
    name: string;
    description: string;
    icon_url: string | null;
    awarded_count: string | null;
    last_checked_at: Date | null;
    meta_refreshed_at: Date;
    not_found_streak: number;
    deleted: boolean;
}

export interface TrackerGuildRow {
    guild_id: string;
    channel_id: string | null;
}

export interface SubscriptionRow {
    guild_id: string;
    badge_id: string;
    ping_role_id: string | null;
    custom_description: string | null;
}

export interface FanoutRow extends SubscriptionRow {
    channel_id: string | null;
}

export interface GuildBadgeRow extends SubscriptionRow {
    name: string;
    description: string;
    icon_url: string | null;
    awarded_count: string | null;
    deleted: boolean;
}

export interface TrackerSettingsRow {
    interval_minutes: number;
    last_round_at: Date | null;
}

export interface RobloxBadge {
    id: string;
    name: string;
    description: string;
    awardedCount: number;
}

export class BadgeTrackerError extends UserFacingError {}
