import { query } from "@/database/connection";
import { isMerchantTarget, merchantKeyOf, merchantTarget } from "../constants/merchants.constants";
import type { BiomeForwardRow } from "../types";

/** Biome and merchant configs live in separate tables; a target says which. */
const location = (table: string, target: string) =>
    isMerchantTarget(target)
        ? { table: table.replace("biome", "merchant"), column: "merchant", key: merchantKeyOf(target) }
        : { table, column: "biome", key: target };

export async function setForwardConfig(guildId: string, biome: string, channelId: string, roleId: string | null): Promise<void> {
    const { table, column, key } = location("bh_biome_forwards", biome);
    await query(
        `INSERT INTO ${table} (guild_id, ${column}, channel_id, role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, ${column}) DO UPDATE SET channel_id = $3, role_id = $4`,
        [guildId, key, channelId, roleId],
    );
}

export async function removeForwardConfig(guildId: string, biome: string): Promise<boolean> {
    const { table, column, key } = location("bh_biome_forwards", biome);
    const result = await query(`DELETE FROM ${table} WHERE guild_id = $1 AND ${column} = $2`, [guildId, key]);
    return (result.rowCount ?? 0) > 0;
}

export async function getForwardConfig(guildId: string, biome: string): Promise<BiomeForwardRow | null> {
    const { table, column, key } = location("bh_biome_forwards", biome);
    const result = await query<BiomeForwardRow>(`SELECT * FROM ${table} WHERE guild_id = $1 AND ${column} = $2`, [guildId, key]);
    return result.rows[0] ? { ...result.rows[0], biome } : null;
}

/** Every forward of a server, merchants included (their `biome` is the merchant target). */
export async function getForwardConfigs(guildId: string): Promise<BiomeForwardRow[]> {
    const result = await query<BiomeForwardRow>(
        `SELECT guild_id, biome, channel_id, role_id FROM bh_biome_forwards WHERE guild_id = $1
         UNION ALL
         SELECT guild_id, $2 || merchant, channel_id, role_id FROM bh_merchant_forwards WHERE guild_id = $1
         ORDER BY biome`,
        [guildId, merchantTarget("")],
    );
    return result.rows;
}
