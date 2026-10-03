import { query } from "./connection";

/** A bot-wide ban (`bot_bans`) - the user can't use any command or component of the bot. */
export interface BotBanRow {
    discord_user_id: string;
    reason: string | null;
    banned_by: string;
    created_at: Date;
}

export type BotPunishmentAction = "ban" | "unban";

/** One entry of a user's punishment history (`bot_punishments`) - kept after an unban. */
export interface BotPunishmentRow {
    id: number;
    discord_user_id: string;
    action: BotPunishmentAction;
    reason: string | null;
    by_user_id: string;
    created_at: Date;
}

export interface BotNoteRow {
    id: number;
    discord_user_id: string;
    note: string;
    author_id: string;
    created_at: Date;
}

export async function getBotBan(discordUserId: string): Promise<BotBanRow | null> {
    const result = await query<BotBanRow>(`SELECT * FROM bot_bans WHERE discord_user_id = $1`, [discordUserId]);
    return result.rows[0] ?? null;
}

/** `false` if the user was already banned (nothing changes - unban first to change the reason). */
export async function insertBotBan(discordUserId: string, reason: string | null, bannedBy: string): Promise<boolean> {
    const result = await query(
        `INSERT INTO bot_bans (discord_user_id, reason, banned_by) VALUES ($1, $2, $3)
         ON CONFLICT (discord_user_id) DO NOTHING`,
        [discordUserId, reason, bannedBy],
    );
    return (result.rowCount ?? 0) > 0;
}

/** `false` if the user wasn't banned. */
export async function deleteBotBan(discordUserId: string): Promise<boolean> {
    const result = await query(`DELETE FROM bot_bans WHERE discord_user_id = $1`, [discordUserId]);
    return (result.rowCount ?? 0) > 0;
}

export async function insertBotPunishment(
    discordUserId: string,
    action: BotPunishmentAction,
    reason: string | null,
    byUserId: string,
): Promise<void> {
    await query(`INSERT INTO bot_punishments (discord_user_id, action, reason, by_user_id) VALUES ($1, $2, $3, $4)`, [
        discordUserId,
        action,
        reason,
        byUserId,
    ]);
}

/** Newest first. */
export async function getBotPunishments(discordUserId: string, limit: number): Promise<BotPunishmentRow[]> {
    const result = await query<BotPunishmentRow>(
        `SELECT * FROM bot_punishments WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [discordUserId, limit],
    );
    return result.rows;
}

export async function insertBotNote(discordUserId: string, note: string, authorId: string): Promise<BotNoteRow> {
    const result = await query<BotNoteRow>(
        `INSERT INTO bot_user_notes (discord_user_id, note, author_id) VALUES ($1, $2, $3) RETURNING *`,
        [discordUserId, note, authorId],
    );
    return result.rows[0];
}

/** Newest first. */
export async function getBotNotes(discordUserId: string, limit: number): Promise<BotNoteRow[]> {
    const result = await query<BotNoteRow>(`SELECT * FROM bot_user_notes WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT $2`, [
        discordUserId,
        limit,
    ]);
    return result.rows;
}

export async function getAllBotBans(): Promise<BotBanRow[]> {
    const result = await query<BotBanRow>(`SELECT * FROM bot_bans`);
    return result.rows;
}
