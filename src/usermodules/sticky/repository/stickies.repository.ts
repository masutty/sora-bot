import { query } from "@/database/connection";
import type { StickyRow } from "../types";

type StickyPatch = Partial<Pick<StickyRow, "content" | "mode" | "delay_seconds" | "message_id" | "last_posted_at">>;

const PATCH_COLUMNS = ["content", "mode", "delay_seconds", "message_id", "last_posted_at"] as const;

export async function listAllStickies(): Promise<StickyRow[]> {
    const result = await query<StickyRow>(`SELECT * FROM sm_stickies`);
    return result.rows;
}

export async function listGuildStickies(guildId: string): Promise<StickyRow[]> {
    const result = await query<StickyRow>(`SELECT * FROM sm_stickies WHERE guild_id = $1 ORDER BY created_at, channel_id`, [guildId]);
    return result.rows;
}

export async function countGuildStickies(guildId: string): Promise<number> {
    const result = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM sm_stickies WHERE guild_id = $1`, [guildId]);
    return Number(result.rows[0]?.count ?? 0);
}

export async function insertSticky(
    row: Pick<StickyRow, "guild_id" | "channel_id" | "content" | "mode" | "delay_seconds" | "created_by">,
): Promise<StickyRow> {
    const result = await query<StickyRow>(
        `INSERT INTO sm_stickies (guild_id, channel_id, content, mode, delay_seconds, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [row.guild_id, row.channel_id, row.content, row.mode, row.delay_seconds, row.created_by],
    );
    return result.rows[0] as StickyRow;
}

/** Updates only the columns present in `patch`; `null` is a value (clears the column), `undefined` is skipped. */
export async function updateSticky(channelId: string, patch: StickyPatch): Promise<StickyRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [channelId];
    for (const column of PATCH_COLUMNS) {
        const value = patch[column];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) {
        const current = await query<StickyRow>(`SELECT * FROM sm_stickies WHERE channel_id = $1`, [channelId]);
        return current.rows[0] ?? null;
    }
    const result = await query<StickyRow>(`UPDATE sm_stickies SET ${sets.join(", ")} WHERE channel_id = $1 RETURNING *`, params);
    return result.rows[0] ?? null;
}

export async function deleteSticky(channelId: string): Promise<StickyRow | null> {
    const result = await query<StickyRow>(`DELETE FROM sm_stickies WHERE channel_id = $1 RETURNING *`, [channelId]);
    return result.rows[0] ?? null;
}

export async function guildUsage(): Promise<Array<{ guild_id: string; count: number }>> {
    const result = await query<{ guild_id: string; count: string }>(
        `SELECT guild_id, COUNT(*) AS count FROM sm_stickies GROUP BY guild_id`,
    );
    return result.rows.map((r) => ({ guild_id: r.guild_id, count: Number(r.count) }));
}
