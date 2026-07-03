import { query } from "../../database/connection";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Note {
    id: number;
    user_id: string;
    guild_id: string;
    moderator_id: string;
    content: string;
    created_at: Date;
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function addNote(
    userId: string,
    guildId: string,
    moderatorId: string,
    content: string,
): Promise<Note> {
    const result = await query<Note>(
        `INSERT INTO mod_notes (user_id, guild_id, moderator_id, content)
		 VALUES ($1, $2, $3, $4)
		 RETURNING *`,
        [userId, guildId, moderatorId, content],
    );
    return result.rows[0];
}

export async function deleteNote(
    noteId: number,
    guildId: string,
): Promise<boolean> {
    const result = await query(
        `DELETE FROM mod_notes WHERE id = $1 AND guild_id = $2`,
        [noteId, guildId],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getNotes(
    userId: string,
    guildId: string,
): Promise<Note[]> {
    const result = await query<Note>(
        `SELECT * FROM mod_notes
		 WHERE user_id = $1 AND guild_id = $2
		 ORDER BY created_at DESC`,
        [userId, guildId],
    );
    return result.rows;
}
