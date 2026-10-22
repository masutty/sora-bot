import { query } from "@/database/connection";

export async function getTrackerChannel(guildId: string): Promise<string | null> {
    const result = await query<{ channel_id: string | null }>(`SELECT channel_id FROM bt_guilds WHERE guild_id = $1`, [guildId]);
    return result.rows[0]?.channel_id ?? null;
}

export async function setTrackerChannel(guildId: string, channelId: string | null): Promise<void> {
    await query(
        `INSERT INTO bt_guilds (guild_id, channel_id) VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
        [guildId, channelId],
    );
}
