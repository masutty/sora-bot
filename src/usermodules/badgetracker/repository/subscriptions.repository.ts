import { query } from "@/database/connection";
import type { FanoutRow, GuildBadgeRow } from "../types";
import { deleteOrphanBadges } from "./badges.repository";

export async function addSubscription(guildId: string, badgeId: string, roleId: string | null): Promise<void> {
    await query(
        `INSERT INTO bt_subscriptions (guild_id, badge_id, ping_role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, badge_id) DO UPDATE SET ping_role_id = $3`,
        [guildId, badgeId, roleId],
    );
}

export async function removeSubscription(guildId: string, badgeId: string): Promise<boolean> {
    const result = await query(`DELETE FROM bt_subscriptions WHERE guild_id = $1 AND badge_id = $2`, [guildId, badgeId]);
    await deleteOrphanBadges();
    return (result.rowCount ?? 0) > 0;
}

export async function getGuildBadges(guildId: string): Promise<GuildBadgeRow[]> {
    const result = await query<GuildBadgeRow>(
        `SELECT s.guild_id, s.badge_id, s.ping_role_id, s.custom_description,
                b.name, b.description, b.icon_url, b.awarded_count, b.deleted
         FROM bt_subscriptions s
         JOIN bt_badges b ON b.badge_id = s.badge_id
         WHERE s.guild_id = $1
         ORDER BY s.created_at`,
        [guildId],
    );
    return result.rows;
}

export async function countGuildSubscriptions(guildId: string): Promise<number> {
    const result = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM bt_subscriptions WHERE guild_id = $1`, [guildId]);
    return Number(result.rows[0]?.count ?? 0);
}

export async function setPingRole(guildId: string, badgeId: string, roleId: string | null): Promise<boolean> {
    const result = await query(`UPDATE bt_subscriptions SET ping_role_id = $3 WHERE guild_id = $1 AND badge_id = $2`, [
        guildId,
        badgeId,
        roleId,
    ]);
    return (result.rowCount ?? 0) > 0;
}

export async function setCustomDescription(guildId: string, badgeId: string, text: string | null): Promise<boolean> {
    const result = await query(`UPDATE bt_subscriptions SET custom_description = $3 WHERE guild_id = $1 AND badge_id = $2`, [
        guildId,
        badgeId,
        text,
    ]);
    return (result.rowCount ?? 0) > 0;
}

export async function getAllFanoutRows(): Promise<FanoutRow[]> {
    const result = await query<FanoutRow>(
        `SELECT s.guild_id, s.badge_id, s.ping_role_id, s.custom_description, g.channel_id
         FROM bt_subscriptions s
         LEFT JOIN bt_guilds g ON g.guild_id = s.guild_id`,
    );
    return result.rows;
}
