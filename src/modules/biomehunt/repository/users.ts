import { query } from "@/database/connection";
import type { ActivityStatus, UserMacroChannelRow, UserRow } from "../types";

export interface ChannelIndexEntry {
    userId: number;
    guildId: string;
    webhookId: string;
}

const channelIndex = new Map<string, ChannelIndexEntry>();

export async function loadChannelIndex(): Promise<void> {
    channelIndex.clear();
    const result = await query<{ channel_id: string; webhook_id: string; user_id: number; guild_id: string }>(
        `SELECT c.channel_id, c.webhook_id, c.user_id, u.guild_id
         FROM bh_user_macro_channels c
         JOIN bh_users u ON u.id = c.user_id`,
    );
    for (const row of result.rows) {
        channelIndex.set(row.channel_id, { userId: row.user_id, guildId: row.guild_id, webhookId: row.webhook_id });
    }
}

export function lookupChannel(channelId: string): ChannelIndexEntry | null {
    return channelIndex.get(channelId) ?? null;
}

export function registerChannel(channelId: string, entry: ChannelIndexEntry): void {
    channelIndex.set(channelId, entry);
}

export function unregisterChannelByUserId(userId: number): void {
    for (const [channelId, entry] of channelIndex) {
        if (entry.userId === userId) {
            channelIndex.delete(channelId);
            return;
        }
    }
}

export async function ensureUser(guildId: string, discordUserId: string): Promise<UserRow> {
    const result = await query<UserRow>(
        `INSERT INTO bh_users (guild_id, discord_user_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET guild_id = bh_users.guild_id
         RETURNING *`,
        [guildId, discordUserId],
    );
    return result.rows[0];
}

export async function getUserByDiscordId(guildId: string, discordUserId: string): Promise<UserRow | null> {
    const result = await query<UserRow>(
        `SELECT * FROM bh_users WHERE guild_id = $1 AND discord_user_id = $2`,
        [guildId, discordUserId],
    );
    return result.rows[0] ?? null;
}

export async function getUserById(userId: number): Promise<UserRow | null> {
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE id = $1`, [userId]);
    return result.rows[0] ?? null;
}

export async function updateUserStatus(userId: number, status: ActivityStatus): Promise<void> {
    await query(`UPDATE bh_users SET current_status = $2 WHERE id = $1`, [userId, status]);
}

export async function touchLastActivity(userId: number, when: Date): Promise<void> {
    await query(`UPDATE bh_users SET last_activity_at = $2 WHERE id = $1`, [userId, when]);
}

/**
 * Clears `last_activity_at` so the user drops out of `getUsersForStatusSweep`'s
 * `WHERE last_activity_at IS NOT NULL` filter - mirrors what a brand new row already gets
 * "for free". Used after a soft macro-channel delete: without this, the user keeps their
 * stale `last_activity_at`, stays "inactive" every tick, and a freshly re-created channel
 * gets deleted again before they can even set up their webhook.
 */
export async function resetActivityState(userId: number): Promise<void> {
    await query(`UPDATE bh_users SET last_activity_at = NULL, current_status = 'inactive' WHERE id = $1`, [userId]);
}

export async function pauseUser(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(
        `UPDATE bh_users SET paused_at = NOW() WHERE guild_id = $1 AND discord_user_id = $2`,
        [guildId, discordUserId],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function unpauseUser(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(
        `UPDATE bh_users SET paused_at = NULL WHERE guild_id = $1 AND discord_user_id = $2`,
        [guildId, discordUserId],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function deleteUserCascade(userId: number): Promise<{ channelId: string; webhookId: string } | null> {
    const channel = await query<{ channel_id: string; webhook_id: string }>(
        `SELECT channel_id, webhook_id FROM bh_user_macro_channels WHERE user_id = $1`,
        [userId],
    );
    await query(`DELETE FROM bh_users WHERE id = $1`, [userId]);
    unregisterChannelByUserId(userId);
    const row = channel.rows[0];
    return row ? { channelId: row.channel_id, webhookId: row.webhook_id } : null;
}

/** Removes only the macro channel/webhook DB row, keeping the user's row (and all their history/badges/quota state) intact. */
export async function deleteMacroChannelOnly(userId: number): Promise<{ channelId: string; webhookId: string } | null> {
    const result = await query<{ channel_id: string; webhook_id: string }>(
        `DELETE FROM bh_user_macro_channels WHERE user_id = $1 RETURNING channel_id, webhook_id`,
        [userId],
    );
    unregisterChannelByUserId(userId);
    const row = result.rows[0];
    return row ? { channelId: row.channel_id, webhookId: row.webhook_id } : null;
}

export async function getUsersForStatusSweep(): Promise<UserRow[]> {
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE last_activity_at IS NOT NULL`);
    return result.rows;
}

export async function getUsersForGuild(guildId: string): Promise<UserRow[]> {
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE guild_id = $1`, [guildId]);
    return result.rows;
}

/** Users in a guild, optionally filtered by status, ordered for a stable paginated listing. */
export async function getUsersByGuildStatus(guildId: string, status: ActivityStatus | null): Promise<UserRow[]> {
    const result = await query<UserRow>(
        `SELECT * FROM bh_users
         WHERE guild_id = $1 AND ($2::text IS NULL OR current_status = $2)
         ORDER BY current_status, last_activity_at DESC NULLS LAST`,
        [guildId, status],
    );
    return result.rows;
}

export async function getGuildUserCounts(guildId: string): Promise<Record<ActivityStatus, number>> {
    const result = await query<{ current_status: ActivityStatus; count: string }>(
        `SELECT current_status, COUNT(*) AS count FROM bh_users WHERE guild_id = $1 GROUP BY current_status`,
        [guildId],
    );
    const counts: Record<ActivityStatus, number> = { active: 0, idle: 0, inactive: 0 };
    for (const row of result.rows) counts[row.current_status] = Number(row.count);
    return counts;
}

export async function createMacroChannel(
    userId: number,
    channelId: string,
    webhookId: string,
    encryptedWebhookUrl: string,
): Promise<UserMacroChannelRow> {
    const result = await query<UserMacroChannelRow>(
        `INSERT INTO bh_user_macro_channels (user_id, channel_id, webhook_id, webhook_url)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, channelId, webhookId, encryptedWebhookUrl],
    );
    return result.rows[0];
}

export async function getMacroChannelByUserId(userId: number): Promise<UserMacroChannelRow | null> {
    const result = await query<UserMacroChannelRow>(`SELECT * FROM bh_user_macro_channels WHERE user_id = $1`, [userId]);
    return result.rows[0] ?? null;
}
