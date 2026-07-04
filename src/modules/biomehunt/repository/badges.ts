import { query } from "@/database/connection";
import type { Badge, GuildBadgeRoleRow, UserBadgeRow } from "../types";

export async function setGuildBadgeRole(guildId: string, badge: Badge, roleId: string): Promise<void> {
    await query(
        `INSERT INTO bh_guild_badge_roles (guild_id, badge, role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, badge) DO UPDATE SET role_id = $3`,
        [guildId, badge, roleId],
    );
}

/** Clears all configured badge roles for a guild at once. */
export async function clearGuildBadgeRoles(guildId: string): Promise<void> {
    await query(`DELETE FROM bh_guild_badge_roles WHERE guild_id = $1`, [guildId]);
}

export async function getGuildBadgeRoles(guildId: string): Promise<GuildBadgeRoleRow[]> {
    const result = await query<GuildBadgeRoleRow>(`SELECT * FROM bh_guild_badge_roles WHERE guild_id = $1`, [guildId]);
    return result.rows;
}

export async function getGuildBadgeRole(guildId: string, badge: Badge): Promise<string | null> {
    const result = await query<GuildBadgeRoleRow>(
        `SELECT * FROM bh_guild_badge_roles WHERE guild_id = $1 AND badge = $2`,
        [guildId, badge],
    );
    return result.rows[0]?.role_id ?? null;
}

export async function hasUserBadge(userId: number, badge: Badge): Promise<boolean> {
    const result = await query(`SELECT 1 FROM bh_user_badges WHERE user_id = $1 AND badge = $2`, [userId, badge]);
    return (result.rowCount ?? 0) > 0;
}

/** Grants a badge if the user doesn't already have it. Returns true iff it was newly granted. */
export async function grantUserBadge(userId: number, badge: Badge): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_user_badges (user_id, badge) VALUES ($1, $2) ON CONFLICT (user_id, badge) DO NOTHING`,
        [userId, badge],
    );
    return (result.rowCount ?? 0) > 0;
}

/** Revokes a badge. Returns true iff the user actually had it. */
export async function revokeUserBadge(userId: number, badge: Badge): Promise<boolean> {
    const result = await query(`DELETE FROM bh_user_badges WHERE user_id = $1 AND badge = $2`, [userId, badge]);
    return (result.rowCount ?? 0) > 0;
}

export async function getUserBadges(userId: number): Promise<UserBadgeRow[]> {
    const result = await query<UserBadgeRow>(
        `SELECT * FROM bh_user_badges WHERE user_id = $1 ORDER BY awarded_at`,
        [userId],
    );
    return result.rows;
}
