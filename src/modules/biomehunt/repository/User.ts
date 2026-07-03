import { query } from "../../../database/connection";

/* ─────────────────────────────────────────── */
/* Types                                      */
/* ─────────────────────────────────────────── */

export interface UserProfile {
    userId: string;
    guildId: string;

    dedicatedChannelId: string;
    webhookId: string | null;
    webhookUrl: string | null;

    currentState: "green" | "yellow" | "red";

    lastActivity: Date | null;

    totalMessages: number;
    totalActiveS: number;

    biomeCounts: Record<string, number>;

    registeredAt: Date;
    updatedAt: Date;
}

/* ─────────────────────────────────────────── */
/* DB Row                                     */
/* ─────────────────────────────────────────── */

interface UserProfileRow {
    user_id: string;
    guild_id: string;

    dedicated_channel_id: string;
    webhook_id: string | null;
    webhook_url: string | null;

    current_state: "green" | "yellow" | "red";

    last_activity: Date | null;

    total_messages: number;
    total_active_s: number;

    biome_counts: Record<string, number>;

    registered_at: Date;
    updated_at: Date;
}

/* ─────────────────────────────────────────── */
/* Cache                                      */
/* ─────────────────────────────────────────── */

const TTL_MS = 30_000;
const cache = new Map<string, { data: UserProfile; expiresAt: number }>();

function cacheKey(userId: string, guildId: string) {
    return `${guildId}:${userId}`;
}

/* ─────────────────────────────────────────── */
/* Mapper                                    */
/* ─────────────────────────────────────────── */

function rowToModel(row: UserProfileRow): UserProfile {
    return {
        userId: row.user_id,
        guildId: row.guild_id,

        dedicatedChannelId: row.dedicated_channel_id,
        webhookId: row.webhook_id,
        webhookUrl: row.webhook_url,

        currentState: row.current_state,

        lastActivity: row.last_activity,

        totalMessages: row.total_messages,
        totalActiveS: row.total_active_s,

        biomeCounts: row.biome_counts ?? {},

        registeredAt: row.registered_at,
        updatedAt: row.updated_at,
    };
}

/* ─────────────────────────────────────────── */
/* READ                                       */
/* ─────────────────────────────────────────── */

export async function getUserProfile(userId: string, guildId: string): Promise<UserProfile | null> {
    const key = cacheKey(userId, guildId);
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    const result = await query<UserProfileRow>(
        `
        SELECT *
        FROM bh_user_profiles
        WHERE user_id = $1 AND guild_id = $2
        `,
        [userId, guildId],
    );

    const row = result.rows[0];
    if (!row) return null;

    const model = rowToModel(row);

    cache.set(key, {
        data: model,
        expiresAt: now + TTL_MS,
    });

    return model;
}

/* ─────────────────────────────────────────── */
/* CREATE                                     */
/* ─────────────────────────────────────────── */

export async function createUserProfile(
    userId: string,
    guildId: string,
    macroChannelId: string,
): Promise<UserProfile> {
    const result = await query<UserProfileRow>(
        `
        INSERT INTO bh_user_profiles (
            user_id,
            guild_id,
            dedicated_channel_id
        )
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [userId, guildId, macroChannelId],
    );

    const model = rowToModel(result.rows[0]);

    cache.set(cacheKey(userId, guildId), {
        data: model,
        expiresAt: Date.now() + TTL_MS,
    });

    return model;
}

/* ─────────────────────────────────────────── */
/* UPDATE (generic partial)                   */
/* ─────────────────────────────────────────── */

export async function updateUserProfile(
    userId: string,
    guildId: string,
    fields: Partial<Omit<UserProfile, "userId" | "guildId">>,
): Promise<void> {
    const columnMap: Record<string, string> = {
        dedicatedChannelId: "dedicated_channel_id",
        webhookId: "webhook_id",
        webhookUrl: "webhook_url",
        currentState: "current_state",
        lastActivity: "last_activity",
        totalMessages: "total_messages",
        totalActiveS: "total_active_s",
        biomeCounts: "biome_counts",
        registeredAt: "registered_at",
        updatedAt: "updated_at",
    };

    const entries = Object.entries(fields);
    if (entries.length === 0) return;

    const setClauses = entries.map(
        ([key], i) => `${columnMap[key]} = $${i + 3}`,
    );

    const values = entries.map(([, v]) => v);

    await query(
        `
        UPDATE bh_user_profiles
        SET ${setClauses.join(", ")}, updated_at = NOW()
        WHERE user_id = $1 AND guild_id = $2
        `,
        [userId, guildId, ...values],
    );

    cache.delete(cacheKey(userId, guildId));
}

/* ─────────────────────────────────────────── */
/* DELETE                                     */
/* ─────────────────────────────────────────── */

export async function deleteUserProfile(
    userId: string,
    guildId: string,
): Promise<void> {
    await query(
        `
        DELETE FROM bh_user_profiles
        WHERE user_id = $1 AND guild_id = $2
        `,
        [userId, guildId],
    );

    cache.delete(cacheKey(userId, guildId));
}
