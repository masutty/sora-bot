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

/** Clears the Tracking Channel only while it still equals `channelId`, so a newly set channel survives a stale clear. */
export async function clearTrackerChannelIf(guildId: string, channelId: string): Promise<void> {
    await query(`UPDATE bt_guilds SET channel_id = NULL WHERE guild_id = $1 AND channel_id = $2`, [guildId, channelId]);
}
