import { query } from "@/database/connection";
import type { QuotaRoleMode, QuotaRoleRow, UserQuotaRoleRow } from "../types";

export async function upsertQuotaRole(
    guildId: string,
    roleId: string,
    mode: QuotaRoleMode,
    quotaTargetSeconds: number,
    quotaWindowHours: number,
    accessDurationDays: number | null,
): Promise<QuotaRoleRow> {
    const result = await query<QuotaRoleRow>(
        `INSERT INTO bh_quota_roles (guild_id, role_id, mode, quota_target_seconds, quota_window_hours, access_duration_days)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (guild_id, role_id) DO UPDATE
         SET mode = $3, quota_target_seconds = $4, quota_window_hours = $5, access_duration_days = $6, updated_at = NOW()
         RETURNING *`,
        [guildId, roleId, mode, quotaTargetSeconds, quotaWindowHours, accessDurationDays],
    );
    return result.rows[0];
}

export async function removeQuotaRole(guildId: string, roleId: string): Promise<boolean> {
    const result = await query(`DELETE FROM bh_quota_roles WHERE guild_id = $1 AND role_id = $2`, [guildId, roleId]);
    return (result.rowCount ?? 0) > 0;
}

export async function getQuotaRolesForGuild(guildId: string): Promise<QuotaRoleRow[]> {
    const result = await query<QuotaRoleRow>(
        `SELECT * FROM bh_quota_roles WHERE guild_id = $1 ORDER BY created_at`,
        [guildId],
    );
    return result.rows;
}

export async function getQuotaRolesByMode(guildId: string, mode: QuotaRoleMode): Promise<QuotaRoleRow[]> {
    const result = await query<QuotaRoleRow>(
        `SELECT * FROM bh_quota_roles WHERE guild_id = $1 AND mode = $2 ORDER BY created_at`,
        [guildId, mode],
    );
    return result.rows;
}

export async function getUserQuotaRole(userId: number, quotaRoleId: number): Promise<UserQuotaRoleRow | null> {
    const result = await query<UserQuotaRoleRow>(
        `SELECT * FROM bh_user_quota_roles WHERE user_id = $1 AND quota_role_id = $2`,
        [userId, quotaRoleId],
    );
    return result.rows[0] ?? null;
}

/** Grants or renews a user's hold on a quota role (upsert on the (user, quota_role) pair). */
export async function grantQuotaRole(userId: number, quotaRoleId: number, expiresAt: Date | null): Promise<void> {
    await query(
        `INSERT INTO bh_user_quota_roles (user_id, quota_role_id, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, quota_role_id) DO UPDATE SET expires_at = $3`,
        [userId, quotaRoleId, expiresAt],
    );
}

export async function revokeQuotaRole(userId: number, quotaRoleId: number): Promise<boolean> {
    const result = await query(
        `DELETE FROM bh_user_quota_roles WHERE user_id = $1 AND quota_role_id = $2`,
        [userId, quotaRoleId],
    );
    return (result.rowCount ?? 0) > 0;
}

export interface QuotaProgressRow extends QuotaRoleRow {
    held_granted_at: Date | null;
    held_expires_at: Date | null;
}

/** Every quota role configured for a guild, joined with whether/when the given user currently holds each one. */
export async function getUserQuotaProgress(guildId: string, userId: number): Promise<QuotaProgressRow[]> {
    const result = await query<QuotaProgressRow>(
        `SELECT qr.*, uqr.granted_at AS held_granted_at, uqr.expires_at AS held_expires_at
         FROM bh_quota_roles qr
         LEFT JOIN bh_user_quota_roles uqr ON uqr.quota_role_id = qr.id AND uqr.user_id = $2
         WHERE qr.guild_id = $1
         ORDER BY qr.created_at`,
        [guildId, userId],
    );
    return result.rows;
}
