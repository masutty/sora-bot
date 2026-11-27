import { query } from "@/database/connection";
import { isMerchantTarget, merchantKeyOf, merchantTarget } from "../constants/merchants.constants";
import type { BiomeDelayedForwardRow } from "../types";

/** Biome and merchant configs live in separate tables; a target says which. */
const location = (target: string) =>
    isMerchantTarget(target)
        ? { table: "bh_merchant_delayed_forwards", column: "merchant", key: merchantKeyOf(target) }
        : { table: "bh_biome_delayed_forwards", column: "biome", key: target };

export async function setDelayedForwardConfig(
    guildId: string,
    biome: string,
    channelId: string,
    roleId: string | null,
    delayS: number,
): Promise<void> {
    const { table, column, key } = location(biome);
    await query(
        `INSERT INTO ${table} (guild_id, ${column}, channel_id, role_id, delay_s)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, ${column}) DO UPDATE SET channel_id = $3, role_id = $4, delay_s = $5`,
        [guildId, key, channelId, roleId, delayS],
    );
}

export async function removeDelayedForwardConfig(guildId: string, biome: string): Promise<boolean> {
    const { table, column, key } = location(biome);
    const result = await query(`DELETE FROM ${table} WHERE guild_id = $1 AND ${column} = $2`, [guildId, key]);
    return (result.rowCount ?? 0) > 0;
}

export async function getDelayedForwardConfig(guildId: string, biome: string): Promise<BiomeDelayedForwardRow | null> {
    const { table, column, key } = location(biome);
    const result = await query<BiomeDelayedForwardRow>(`SELECT * FROM ${table} WHERE guild_id = $1 AND ${column} = $2`, [guildId, key]);
    return result.rows[0] ? { ...result.rows[0], biome } : null;
}

/** Every delayed forward of a server, merchants included (their `biome` is the merchant target). */
export async function getDelayedForwardConfigs(guildId: string): Promise<BiomeDelayedForwardRow[]> {
    const result = await query<BiomeDelayedForwardRow>(
        `SELECT guild_id, biome, channel_id, role_id, delay_s FROM bh_biome_delayed_forwards WHERE guild_id = $1
         UNION ALL
         SELECT guild_id, $2 || merchant, channel_id, role_id, delay_s FROM bh_merchant_delayed_forwards WHERE guild_id = $1
         ORDER BY biome`,
        [guildId, merchantTarget("")],
    );
    return result.rows;
}
