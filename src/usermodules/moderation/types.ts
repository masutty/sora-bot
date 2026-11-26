import { UserFacingError } from "@/define";

export type CaseKind = "warn" | "mute" | "kick" | "ban" | "softban" | "temprole";
export type EndReason = "expired" | "revoked" | "replaced";
export type CaseEventKind = "created" | "revoked" | "expired" | "replaced" | "reason_changed" | "auto_undone";
export type ThresholdAction = "mute" | "kick" | "ban";

export interface CaseRow {
    id: string;
    guild_id: string;
    kind: CaseKind;
    user_id: string;
    /** `null` is the bot (Auto-Punishment). */
    moderator_id: string | null;
    reason: string;
    weight: number;
    role_id: string | null;
    created_at: Date;
    expires_at: Date | null;
    ended_at: Date | null;
    end_reason: EndReason | null;
    ended_by: string | null;
    end_note: string | null;
    triggered_by: string | null;
    threshold_level: number | null;
    dm_delivered: boolean | null;
    /** Why the DM failed; `null` when it was delivered or never sent. */
    dm_error: string | null;
}

export interface CaseEventRow {
    id: string;
    case_id: string;
    kind: CaseEventKind;
    by_id: string | null;
    data: Record<string, unknown>;
    at: Date;
}

export interface ModSettings {
    guild_id: string;
    case_channel_id: string | null;
    warn_expiry_days: number;
    auto_enabled: boolean;
    auto_undo: boolean;
    appeal_line: string | null;
    moderator_role_id: string | null;
}

export interface Threshold {
    warns: number;
    action: ThresholdAction | null;
    durationS: number | null;
}

/** Carries a message that is safe to show the user as is. */
export class ModerationError extends UserFacingError {}
