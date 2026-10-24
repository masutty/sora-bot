import type { PoolClient } from "pg";
import { query } from "@/database/connection";
import { getAllBiomes } from "../constants/biomes.constants";
import type { ActivityGrace, ActivityStatus, UserMacroChannelRow, UserRow } from "../types";
import { NOT_FAKE_SQL } from "./activity.repository";

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
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE guild_id = $1 AND discord_user_id = $2`, [guildId, discordUserId]);
    return result.rows[0] ?? null;
}

/** Every profile a Discord user has across guilds - used by owner-only commands that let `guild_id`
 * be omitted, to auto-resolve it when the user only has one profile (and ask to disambiguate otherwise). */
export async function getUsersByDiscordId(discordUserId: string): Promise<UserRow[]> {
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE discord_user_id = $1`, [discordUserId]);
    return result.rows;
}

export async function getUserById(userId: number): Promise<UserRow | null> {
    const result = await query<UserRow>(`SELECT * FROM bh_users WHERE id = $1`, [userId]);
    return result.rows[0] ?? null;
}

export async function updateUserStatus(userId: number, status: ActivityStatus): Promise<void> {
    await query(`UPDATE bh_users SET current_status = $2 WHERE id = $1`, [userId, status]);
}

export async function touchLastActivity(userId: number, when: Date, grace: ActivityGrace): Promise<void> {
    await query(`UPDATE bh_users SET last_activity_at = $2, activity_grace_until = $3, activity_grace_biome = $4 WHERE id = $1`, [
        userId,
        when,
        grace.until,
        grace.biome,
    ]);
}

/**
 * Clears `last_activity_at` so the user drops out of `getUsersForStatusSweep`'s
 * `WHERE last_activity_at IS NOT NULL` filter - mirrors what a brand new row already gets
 * "for free". Used after a soft macro-channel delete: without this, the user keeps their
 * stale `last_activity_at`, stays "inactive" every tick, and a freshly re-created channel
 * gets deleted again before they can even set up their webhook.
 */
export async function resetActivityState(userId: number): Promise<void> {
    await query(
        `UPDATE bh_users SET last_activity_at = NULL, activity_grace_until = NULL, activity_grace_biome = NULL, current_status = 'inactive' WHERE id = $1`,
        [userId],
    );
}

export async function pauseUser(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(`UPDATE bh_users SET paused_at = NOW() WHERE guild_id = $1 AND discord_user_id = $2`, [
        guildId,
        discordUserId,
    ]);
    return (result.rowCount ?? 0) > 0;
}

export async function unpauseUser(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(`UPDATE bh_users SET paused_at = NULL WHERE guild_id = $1 AND discord_user_id = $2`, [
        guildId,
        discordUserId,
    ]);
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

export interface ChannelNameCandidate {
    userId: number;
    guildId: string;
    channelId: string;
    nameBadges: string;
    renamedAt: Date | null;
    flagOn: boolean;
}

/** Macro channels whose name may need a rename: the flag is on for the server, or badges are still stored. Oldest rename first. */
export async function getChannelNameCandidates(): Promise<ChannelNameCandidate[]> {
    const result = await query<{
        user_id: number;
        guild_id: string;
        channel_id: string;
        name_badges: string;
        name_renamed_at: Date | null;
        flag_on: boolean;
    }>(
        `SELECT c.user_id, u.guild_id, c.channel_id, c.name_badges, c.name_renamed_at,
                COALESCE(f.enabled, FALSE) AS flag_on
         FROM bh_user_macro_channels c
         JOIN bh_users u ON u.id = c.user_id
         LEFT JOIN bh_guild_flags f ON f.guild_id = u.guild_id AND f.flag_name = 'RARE_COUNT_IN_CHANNEL_NAME'
         WHERE COALESCE(f.enabled, FALSE) OR c.name_badges <> ''
         ORDER BY c.name_renamed_at ASC NULLS FIRST`,
    );
    return result.rows.map((r) => ({
        userId: r.user_id,
        guildId: r.guild_id,
        channelId: r.channel_id,
        nameBadges: r.name_badges,
        renamedAt: r.name_renamed_at,
        flagOn: r.flag_on,
    }));
}

/** SQL predicate over an events alias `e`: the find counts - not fake, and its newest vote isn't still open (a find with no vote counts). */
const COUNTED_FIND_SQL = `${NOT_FAKE_SQL}
           AND NOT EXISTS (SELECT 1 FROM bh_biome_votes v WHERE v.event_id = e.id AND v.status = 'open'
                 AND v.created_at = (SELECT MAX(v2.created_at) FROM bh_biome_votes v2 WHERE v2.event_id = e.id))`;

/** Which of `biomes` the user has a counted find of. */
export async function getFoundBiomes(userId: number, biomes: string[]): Promise<Set<string>> {
    if (biomes.length === 0) return new Set();
    const result = await query<{ biome: string }>(
        `SELECT DISTINCT e.biome FROM bh_activity_events e
         WHERE e.user_id = $1 AND e.event_type = 'started' AND e.biome = ANY($2) AND ${COUNTED_FIND_SQL}`,
        [userId, biomes],
    );
    return new Set(result.rows.map((r) => r.biome));
}

/** Counted finds per user of the biomes shown in channel names. */
export async function getChannelNameCounts(userIds: number[]): Promise<Map<number, Array<{ biome: string; count: number }>>> {
    const counts = new Map<number, Array<{ biome: string; count: number }>>();
    const biomes = getAllBiomes()
        .filter((b) => b.showInChannelName)
        .map((b) => b.key);
    if (userIds.length === 0 || biomes.length === 0) return counts;
    const result = await query<{ user_id: number; biome: string; count: string }>(
        `SELECT e.user_id, e.biome, COUNT(*) AS count
         FROM bh_activity_events e
         WHERE e.user_id = ANY($1) AND e.event_type = 'started' AND e.biome = ANY($2) AND ${COUNTED_FIND_SQL}
         GROUP BY e.user_id, e.biome`,
        [userIds, biomes],
    );
    for (const r of result.rows) {
        const list = counts.get(r.user_id) ?? [];
        list.push({ biome: r.biome, count: Number(r.count) });
        counts.set(r.user_id, list);
    }
    return counts;
}

/** Stores the badges applied to a macro channel's name and stamps the rename time. */
export async function setNameBadges(userId: number, badges: string): Promise<void> {
    await query(`UPDATE bh_user_macro_channels SET name_badges = $2, name_renamed_at = NOW() WHERE user_id = $1`, [userId, badges]);
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

/** Reroll: swaps the user's Flower in place. Never touches the webhook's id/token/URL - callers
 * only edit the already-existing Discord webhook's name/avatar to match. */
export async function setUserFlower(userId: number, flower: string): Promise<UserRow | null> {
    const result = await query<UserRow>(`UPDATE bh_users SET flower = $2 WHERE id = $1 RETURNING *`, [userId, flower]);
    return result.rows[0] ?? null;
}

export interface UserProgressWipe {
    sessions: number;
    finds: number;
    badges: string[];
    seeds: number;
    xp: number;
    /** Discord role ids of the quota roles the user held. */
    quotaRoleIds: string[];
}

/**
 * Erases a user's progress inside the caller's transaction: activity events (biome finds; their
 * rewards cascade), sessions, badges, quota status, Seeds and XP. The user row, macro channel and
 * Flower stay. Returns what was erased, counted before deleting.
 */
export async function wipeUserProgress(client: PoolClient, userId: number): Promise<UserProgressWipe> {
    const balance = await client.query<{ seeds: number; xp: number }>(`SELECT seeds, xp FROM bh_users WHERE id = $1 FOR UPDATE`, [userId]);
    const badges = await client.query<{ badge: string }>(`DELETE FROM bh_user_badges WHERE user_id = $1 RETURNING badge`, [userId]);
    const quotas = await client.query<{ role_id: string }>(
        `DELETE FROM bh_user_quota_roles uqr USING bh_quota_roles qr
         WHERE uqr.user_id = $1 AND qr.id = uqr.quota_role_id
         RETURNING qr.role_id`,
        [userId],
    );
    const events = await client.query<{ event_type: string }>(`DELETE FROM bh_activity_events WHERE user_id = $1 RETURNING event_type`, [
        userId,
    ]);
    const sessions = await client.query(`DELETE FROM bh_activity_sessions WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE bh_users SET seeds = 0, xp = 0 WHERE id = $1`, [userId]);
    return {
        sessions: sessions.rowCount ?? 0,
        finds: events.rows.filter((e) => e.event_type === "started").length,
        badges: badges.rows.map((b) => b.badge),
        seeds: balance.rows[0]?.seeds ?? 0,
        xp: balance.rows[0]?.xp ?? 0,
        quotaRoleIds: quotas.rows.map((q) => q.role_id),
    };
}
