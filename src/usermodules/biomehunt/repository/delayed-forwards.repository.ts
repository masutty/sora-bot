import { query } from "@/database/connection";
import type { BiomeDelayedForwardRow } from "../types";

export async function setDelayedForwardConfig(
    guildId: string,
    biome: string,
    channelId: string,
    roleId: string | null,
    delayS: number,
): Promise<void> {
    await query(
        `INSERT INTO bh_biome_delayed_forwards (guild_id, biome, channel_id, role_id, delay_s)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, biome) DO UPDATE SET channel_id = $3, role_id = $4, delay_s = $5`,
        [guildId, biome, channelId, roleId, delayS],
    );
}

export async function removeDelayedForwardConfig(guildId: string, biome: string): Promise<boolean> {
    const result = await query(`DELETE FROM bh_biome_delayed_forwards WHERE guild_id = $1 AND biome = $2`, [guildId, biome]);
    return (result.rowCount ?? 0) > 0;
}

export async function getDelayedForwardConfig(guildId: string, biome: string): Promise<BiomeDelayedForwardRow | null> {
    const result = await query<BiomeDelayedForwardRow>(`SELECT * FROM bh_biome_delayed_forwards WHERE guild_id = $1 AND biome = $2`, [
        guildId,
        biome,
    ]);
    return result.rows[0] ?? null;
}

export async function getDelayedForwardConfigs(guildId: string): Promise<BiomeDelayedForwardRow[]> {
    const result = await query<BiomeDelayedForwardRow>(`SELECT * FROM bh_biome_delayed_forwards WHERE guild_id = $1 ORDER BY biome`, [
        guildId,
    ]);
    return result.rows;
}
