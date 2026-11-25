import { query } from "@/database/connection";
import { settings } from "../settings";

export async function getDefaultLimit(): Promise<number> {
    const result = await query<{ default_limit: number }>(`SELECT default_limit FROM sm_settings WHERE id = 1`);
    return result.rows[0]?.default_limit ?? settings.defaultLimit;
}

export async function setDefaultLimit(n: number): Promise<void> {
    await query(
        `INSERT INTO sm_settings (id, default_limit) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET default_limit = $1`,
        [n],
    );
}

/** The guild's override, or the default limit when it has none. */
export async function getGuildLimit(guildId: string): Promise<number> {
    const result = await query<{ max_stickies: number }>(`SELECT max_stickies FROM sm_guild_limits WHERE guild_id = $1`, [guildId]);
    return result.rows[0]?.max_stickies ?? (await getDefaultLimit());
}

/** `null` clears the override. */
export async function setGuildLimit(guildId: string, n: number | null): Promise<void> {
    if (n === null) {
        await query(`DELETE FROM sm_guild_limits WHERE guild_id = $1`, [guildId]);
        return;
    }
    await query(
        `INSERT INTO sm_guild_limits (guild_id, max_stickies) VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET max_stickies = $2`,
        [guildId, n],
    );
}

export async function listGuildLimits(): Promise<Array<{ guild_id: string; max_stickies: number }>> {
    const result = await query<{ guild_id: string; max_stickies: number }>(`SELECT guild_id, max_stickies FROM sm_guild_limits`);
    return result.rows;
}
