import { query } from "../../../database/connection";

/* ───────────────────────────────────────────── */
/* Types                                        */
/* ───────────────────────────────────────────── */

export interface GuildConfig {
    guildId: string;
    greenRoleId: string | null;
    yellowRoleId: string | null;
    redRoleId: string | null;
    yellowThresholdS: number;
    redThresholdS: number;
    counterChannelId: string | null;
    counterMessageId: string | null;
    macroCategoryIds: string[];
}

interface CacheEntry {
    config: GuildConfig;
    expiresAt: number;
}

/* ───────────────────────────────────────────── */
/* Row type (matches bh_guild_config columns)   */
/* ───────────────────────────────────────────── */

interface GuildConfigRow {
    guild_id: string;
    green_role_id: string | null;
    yellow_role_id: string | null;
    red_role_id: string | null;
    yellow_threshold_s: number;
    red_threshold_s: number;
    counter_channel_id: string | null;
    counter_message_id: string | null;
    macro_category_ids: string[];
}

/* ───────────────────────────────────────────── */
/* Cache                                        */
/* ───────────────────────────────────────────── */

const TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function rowToConfig(row: GuildConfigRow): GuildConfig {
    return {
        guildId: row.guild_id,
        greenRoleId: row.green_role_id,
        yellowRoleId: row.yellow_role_id,
        redRoleId: row.red_role_id,
        yellowThresholdS: row.yellow_threshold_s,
        redThresholdS: row.red_threshold_s,
        counterChannelId: row.counter_channel_id,
        counterMessageId: row.counter_message_id,
        macroCategoryIds: row.macro_category_ids,
    };
}

/* ───────────────────────────────────────────── */
/* Public API                                   */
/* ───────────────────────────────────────────── */

/**
 * Returns the guild config, hitting the cache first.
 * Returns null if the guild has no config row yet.
 */
export async function getGuildConfig(
    guildId: string,
): Promise<GuildConfig | null> {
    const now = Date.now();
    const cached = cache.get(guildId);

    if (cached && cached.expiresAt > now) {
        return cached.config;
    }

    const result = await query<GuildConfigRow>(
        `
        SELECT *
        FROM bh_guild_config
        WHERE guild_id = $1
        `,
        [guildId],
    );

    const row = result.rows[0];
    if (!row) return null;

    const config = rowToConfig(row);
    cache.set(guildId, { config, expiresAt: now + TTL_MS });

    return config;
}

/**
 * Forcibly removes a guild from the cache.
 * Call this after any admin command that writes to bh_guild_config
 * so the next read picks up the new values within the same request.
 */
export function invalidateGuildConfig(guildId: string): void {
    cache.delete(guildId);
}

/**
 * Upserts a partial config and invalidates the cache entry.
 * Only the provided fields are updated; omitted fields keep their DB value.
 */
export async function setGuildConfig(
    guildId: string,
    fields: Partial<Omit<GuildConfig, "guildId">>,
): Promise<void> {
    await query(
        `
        INSERT INTO bh_guild_config (guild_id)
        VALUES ($1)
        ON CONFLICT (guild_id) DO NOTHING
        `,
        [guildId],
    );

    const columnMap: Record<keyof Omit<GuildConfig, "guildId">, string> = {
        greenRoleId: "green_role_id",
        yellowRoleId: "yellow_role_id",
        redRoleId: "red_role_id",
        yellowThresholdS: "yellow_threshold_s",
        redThresholdS: "red_threshold_s",
        counterChannelId: "counter_channel_id",
        counterMessageId: "counter_message_id",
        macroCategoryIds: "macro_category_ids",
    };

    const entries = Object.entries(fields) as [keyof Omit<GuildConfig, "guildId">, unknown][];
    if (entries.length === 0) return;

    const setClauses = entries.map(
        ([key], i) => `${columnMap[key]} = $${i + 2}`,
    );
    const values = entries.map(([, v]) => v);

    await query(
        `
        UPDATE bh_guild_config
        SET ${setClauses.join(", ")}, updated_at = NOW()
        WHERE guild_id = $1
        `,
        [guildId, ...values],
    );

    invalidateGuildConfig(guildId);
}
