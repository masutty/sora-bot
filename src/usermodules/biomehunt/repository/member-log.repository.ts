import { query } from "@/database/connection";
import type { MemberLogEntry, MemberLogRow } from "../types";

export async function insertMemberLog(
    guildId: string,
    discordUserId: string,
    byDiscordId: string | null,
    entry: MemberLogEntry,
): Promise<void> {
    await query(`INSERT INTO bh_member_log (guild_id, discord_user_id, kind, detail, by_discord_id) VALUES ($1, $2, $3, $4, $5)`, [
        guildId,
        discordUserId,
        entry.kind,
        JSON.stringify(entry.detail),
        byDiscordId,
    ]);
}

/** Everything logged for one member in a server, newest first. */
export async function getMemberLog(guildId: string, discordUserId: string): Promise<MemberLogRow[]> {
    const result = await query<MemberLogRow>(
        `SELECT * FROM bh_member_log WHERE guild_id = $1 AND discord_user_id = $2 ORDER BY created_at DESC, id DESC`,
        [guildId, discordUserId],
    );
    return result.rows;
}
