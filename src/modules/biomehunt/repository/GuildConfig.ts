import { query } from "../../../database/connection";

/* ─────────────────────────────────────────── */
/* Types                                      */
/* ─────────────────────────────────────────── */

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

    createdAt: Date;
    updatedAt: Date;
}

/* ─────────────────────────────────────────── */
/* DB Row                                     */
/* ─────────────────────────────────────────── */

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

    created_at: Date;
    updated_at: Date;
}

/* ─────────────────────────────────────────── */
/* Cache                                      */
/* ─────────────────────────────────────────── */

const TTL_MS = 30_000;
const cache = new Map<string, { data: GuildConfig; expiresAt: number }>();

/* ─────────────────────────────────────────── */
/* Mapper                                    */
/* ─────────────────────────────────────────── */

function rowToModel(row: GuildConfigRow): GuildConfig {
    return {
        guildId: row.guild_id,

        greenRoleId: row.green_role_id,
        yellowRoleId: row.yellow_role_id,
        redRoleId: row.red_role_id,

        yellowThresholdS: row.yellow_threshold_s,
        redThresholdS: row.red_threshold_s,

        counterChannelId: row.counter_channel_id,
        counterMessageId: row.counter_message_id,

        macroCategoryIds: row.macro_category_ids ?? [],

        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function cacheKey(guildId: string) {
    return guildId;
}

/* ─────────────────────────────────────────── */
/* READ                                       */
/* ─────────────────────────────────────────── */

export async function getGuildConfig(
    guildId: string,
): Promise<GuildConfig | null> {
    const now = Date.now();

    const cached = cache.get(guildId);
    if (cached && cached.expiresAt > now) {
        return cached.data;
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

    const model = rowToModel(row);

    cache.set(guildId, {
        data: model,
        expiresAt: now + TTL_MS,
    });

    return model;
}

/* ─────────────────────────────────────────── */
/* CREATE (upsert base row)                  */
/* ─────────────────────────────────────────── */

export async function createGuildConfig(
    guildId: string,
): Promise<GuildConfig> {
    const result = await query<GuildConfigRow>(
        `
        INSERT INTO bh_guild_config (guild_id)
        VALUES ($1)
        ON CONFLICT (guild_id) DO NOTHING
        RETURNING *
        `,
        [guildId],
    );

    // If already exists, fetch it
    if (!result.rows[0]) {
        const existing = await getGuildConfig(guildId);
        if (!existing) throw new Error("Failed to create or fetch guild config");
        return existing;
    }

    const model = rowToModel(result.rows[0]);

    cache.set(guildId, {
        data: model,
        expiresAt: Date.now() + TTL_MS,
    });

    return model;
}

/* ─────────────────────────────────────────── */
/* UPDATE (partial / verboso)                */
/* ─────────────────────────────────────────── */

export async function updateGuildConfig(
    guildId: string,
    fields: Partial<Omit<GuildConfig, "guildId" | "createdAt" | "updatedAt">>,
): Promise<void> {
    const columnMap: Record<string, string> = {
        greenRoleId: "green_role_id",
        yellowRoleId: "yellow_role_id",
        redRoleId: "red_role_id",

        yellowThresholdS: "yellow_threshold_s",
        redThresholdS: "red_threshold_s",

        counterChannelId: "counter_channel_id",
        counterMessageId: "counter_message_id",

        macroCategoryIds: "macro_category_ids",
    };

    const entries = Object.entries(fields);
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

    cache.delete(guildId);
}

/* ─────────────────────────────────────────── */
/* DELETE                                     */
/* ─────────────────────────────────────────── */

export async function deleteGuildConfig(
    guildId: string,
): Promise<void> {
    await query(
        `
        DELETE FROM bh_guild_config
        WHERE guild_id = $1
        `,
        [guildId],
    );

    cache.delete(guildId);
}

/* ─────────────────────────────────────────── */
/* CACHE CONTROL                              */
/* ─────────────────────────────────────────── */

export function invalidateGuildConfig(guildId: string): void {
    cache.delete(guildId);
}
