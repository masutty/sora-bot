import { query } from "@/database/connection";
import { TTLCache } from "@/utils/cache";
import type { GuildCategoryRow, GuildConfigRow, GuildRolesConfig } from "../types";

const configCache = new TTLCache<string, GuildConfigRow>(60 * 1000);
const rolesCache = new TTLCache<string, GuildRolesConfig>(60 * 1000);

function invalidate(guildId: string): void {
    configCache.delete(guildId);
    rolesCache.delete(guildId);
}

export async function getOrCreateGuildConfig(guildId: string): Promise<GuildConfigRow> {
    const cached = configCache.get(guildId);
    if (cached) return cached;

    const result = await query<GuildConfigRow>(
        `INSERT INTO bh_guilds (guild_id)
         VALUES ($1)
         ON CONFLICT (guild_id) DO UPDATE SET updated_at = bh_guilds.updated_at
         RETURNING *`,
        [guildId],
    );
    const config = result.rows[0];
    configCache.set(guildId, config);
    return config;
}

export function invalidateGuildConfigCache(guildId: string): void {
    invalidate(guildId);
}

export async function updateThresholds(
    guildId: string,
    sessionGapS: number,
    idleS: number,
    inactiveS: number,
): Promise<void> {
    await query(
        `UPDATE bh_guilds
         SET session_gap_threshold_s = $2, idle_threshold_s = $3, inactive_threshold_s = $4, updated_at = NOW()
         WHERE guild_id = $1`,
        [guildId, sessionGapS, idleS, inactiveS],
    );
    invalidate(guildId);
}

export async function resetThresholds(guildId: string): Promise<void> {
    await updateThresholds(guildId, 1200, 1800, 86400);
}

export async function setQuotaEvalHour(guildId: string, hourUtc: number): Promise<void> {
    await query(
        `UPDATE bh_guilds SET quota_eval_hour_utc = $2, updated_at = NOW() WHERE guild_id = $1`,
        [guildId, hourUtc],
    );
    invalidate(guildId);
}

/** Marks a guild's F-mode quota rewards as evaluated for today (UTC), so the daily sweep doesn't re-run today. */
export async function markQuotaEvaluated(guildId: string): Promise<void> {
    await query(
        `UPDATE bh_guilds SET quota_last_evaluated_date = (NOW() AT TIME ZONE 'UTC')::date WHERE guild_id = $1`,
        [guildId],
    );
    invalidate(guildId);
}

/**
 * Guilds with at least one F-mode quota role that are due for their daily
 * evaluation right now: past today's configured UTC eval hour, and not
 * already evaluated today. Computed entirely in SQL to avoid JS-side
 * timezone handling of the stored DATE column.
 */
export async function getGuildsDueForFixedRewardEval(): Promise<GuildConfigRow[]> {
    const result = await query<GuildConfigRow>(
        `SELECT g.* FROM bh_guilds g
         WHERE EXISTS (SELECT 1 FROM bh_quota_roles qr WHERE qr.guild_id = g.guild_id AND qr.mode = 'F')
           AND (g.quota_last_evaluated_date IS NULL OR g.quota_last_evaluated_date < (NOW() AT TIME ZONE 'UTC')::date)
           AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'UTC')) >= g.quota_eval_hour_utc`,
    );
    return result.rows;
}

/** Sets (or disables, with `null`) auto-deletion of a user's macro channel after prolonged inactivity. */
export async function setAutoDeleteAfter(guildId: string, seconds: number | null): Promise<void> {
    await query(
        `UPDATE bh_guilds SET delete_inactive_after_s = $2, updated_at = NOW() WHERE guild_id = $1`,
        [guildId, seconds],
    );
    invalidate(guildId);
}

export async function setAutoCreateCategories(guildId: string, enabled: boolean): Promise<void> {
    await query(
        `UPDATE bh_guilds SET auto_create_categories = $2, updated_at = NOW() WHERE guild_id = $1`,
        [guildId, enabled],
    );
    invalidate(guildId);
}

export async function setCounterChannel(guildId: string, channelId: string): Promise<void> {
    await query(
        `UPDATE bh_guilds SET counter_channel_id = $2, counter_message_id = NULL, updated_at = NOW() WHERE guild_id = $1`,
        [guildId, channelId],
    );
    invalidate(guildId);
}

export async function disableCounter(guildId: string): Promise<void> {
    await query(
        `UPDATE bh_guilds SET counter_channel_id = NULL, counter_message_id = NULL, updated_at = NOW() WHERE guild_id = $1`,
        [guildId],
    );
    invalidate(guildId);
}

export async function setCounterMessageId(guildId: string, messageId: string): Promise<void> {
    await query(`UPDATE bh_guilds SET counter_message_id = $2 WHERE guild_id = $1`, [guildId, messageId]);
    invalidate(guildId);
}

export async function getGuildsWithCounterEnabled(): Promise<GuildConfigRow[]> {
    const result = await query<GuildConfigRow>(`SELECT * FROM bh_guilds WHERE counter_channel_id IS NOT NULL`);
    return result.rows;
}

export async function addCategory(guildId: string, categoryId: string): Promise<void> {
    await query(
        `INSERT INTO bh_guild_categories (guild_id, discord_category_id, is_enabled)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (guild_id, discord_category_id) DO UPDATE SET is_enabled = TRUE`,
        [guildId, categoryId],
    );
}

export async function removeCategory(guildId: string, categoryId: string): Promise<boolean> {
    const result = await query(
        `DELETE FROM bh_guild_categories WHERE guild_id = $1 AND discord_category_id = $2`,
        [guildId, categoryId],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getEnabledCategories(guildId: string): Promise<GuildCategoryRow[]> {
    const result = await query<GuildCategoryRow>(
        `SELECT * FROM bh_guild_categories WHERE guild_id = $1 AND is_enabled = TRUE`,
        [guildId],
    );
    return result.rows;
}

export async function getGuildRoles(guildId: string): Promise<GuildRolesConfig> {
    const cached = rolesCache.get(guildId);
    if (cached) return cached;

    const result = await query<{ active_role_id: string | null; idle_role_id: string | null; inactive_role_id: string | null }>(
        `INSERT INTO bh_guild_roles (guild_id)
         VALUES ($1)
         ON CONFLICT (guild_id) DO UPDATE SET guild_id = bh_guild_roles.guild_id
         RETURNING active_role_id, idle_role_id, inactive_role_id`,
        [guildId],
    );
    const row = result.rows[0];
    const roles: GuildRolesConfig = { active: row.active_role_id, idle: row.idle_role_id, inactive: row.inactive_role_id };
    rolesCache.set(guildId, roles);
    return roles;
}

export async function setGuildRoles(guildId: string, active: string, idle: string, inactive: string): Promise<void> {
    await query(
        `INSERT INTO bh_guild_roles (guild_id, active_role_id, idle_role_id, inactive_role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id) DO UPDATE SET active_role_id = $2, idle_role_id = $3, inactive_role_id = $4`,
        [guildId, active, idle, inactive],
    );
    invalidate(guildId);
}

export async function clearGuildRoles(guildId: string): Promise<void> {
    await query(
        `UPDATE bh_guild_roles SET active_role_id = NULL, idle_role_id = NULL, inactive_role_id = NULL WHERE guild_id = $1`,
        [guildId],
    );
    invalidate(guildId);
}

export async function isGuildReady(
    guildId: string,
): Promise<{ ready: boolean; hasCategory: boolean; hasRoles: boolean }> {
    await getOrCreateGuildConfig(guildId);
    const categories = await getEnabledCategories(guildId);
    const roles = await getGuildRoles(guildId);
    const hasCategory = categories.length > 0;
    const hasRoles = Boolean(roles.active && roles.idle && roles.inactive);
    return { ready: hasCategory && hasRoles, hasCategory, hasRoles };
}

export async function resetGuildConfig(guildId: string): Promise<void> {
    await query(`DELETE FROM bh_guild_categories WHERE guild_id = $1`, [guildId]);
    await clearGuildRoles(guildId);
    await query(
        `UPDATE bh_guilds
         SET session_gap_threshold_s = 1200, idle_threshold_s = 1800, inactive_threshold_s = 86400,
             auto_create_categories = FALSE, delete_inactive_after_s = NULL,
             counter_channel_id = NULL, counter_message_id = NULL, updated_at = NOW()
         WHERE guild_id = $1`,
        [guildId],
    );
    invalidate(guildId);
}
