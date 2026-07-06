import { query } from "@/database/connection";
import type { BiomeForwardRow } from "../types";

export async function setForwardConfig(guildId: string, biome: string, channelId: string, roleId: string | null): Promise<void> {
    await query(
        `INSERT INTO bh_biome_forwards (guild_id, biome, channel_id, role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, biome) DO UPDATE SET channel_id = $3, role_id = $4`,
        [guildId, biome, channelId, roleId],
    );
}

export async function removeForwardConfig(guildId: string, biome: string): Promise<boolean> {
    const result = await query(`DELETE FROM bh_biome_forwards WHERE guild_id = $1 AND biome = $2`, [guildId, biome]);
    return (result.rowCount ?? 0) > 0;
}

export async function getForwardConfig(guildId: string, biome: string): Promise<BiomeForwardRow | null> {
    const result = await query<BiomeForwardRow>(
        `SELECT * FROM bh_biome_forwards WHERE guild_id = $1 AND biome = $2`,
        [guildId, biome],
    );
    return result.rows[0] ?? null;
}

export async function getForwardConfigs(guildId: string): Promise<BiomeForwardRow[]> {
    const result = await query<BiomeForwardRow>(
        `SELECT * FROM bh_biome_forwards WHERE guild_id = $1 ORDER BY biome`,
        [guildId],
    );
    return result.rows;
}
