import { query } from "@/database/connection";
import type { CaseEventKind, CaseEventRow, CaseKind, CaseRow, EndReason } from "../types";

export type NewCase = Pick<CaseRow, "id" | "guild_id" | "kind" | "user_id" | "moderator_id" | "reason"> &
    Partial<
        Pick<CaseRow, "weight" | "role_id" | "created_at" | "expires_at" | "triggered_by" | "threshold_level" | "dm_delivered" | "dm_error">
    >;

export async function insertCase(row: NewCase): Promise<CaseRow> {
    const result = await query<CaseRow>(
        `INSERT INTO mod_cases
            (id, guild_id, kind, user_id, moderator_id, reason, weight, role_id, created_at, expires_at, triggered_by, threshold_level, dm_delivered, dm_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10, $11, $12, $13, $14) RETURNING *`,
        [
            row.id,
            row.guild_id,
            row.kind,
            row.user_id,
            row.moderator_id,
            row.reason,
            row.weight ?? 1,
            row.role_id ?? null,
            row.created_at ?? null,
            row.expires_at ?? null,
            row.triggered_by ?? null,
            row.threshold_level ?? null,
            row.dm_delivered ?? null,
            row.dm_error ?? null,
        ],
    );
    return result.rows[0] as CaseRow;
}

export async function getCase(guildId: string, id: string): Promise<CaseRow | null> {
    const result = await query<CaseRow>(`SELECT * FROM mod_cases WHERE guild_id = $1 AND id = $2`, [guildId, id]);
    return result.rows[0] ?? null;
}

/** Newest first, every kind, revoked and expired included. */
export async function listUserCases(guildId: string, userId: string, page: { limit: number; offset: number }): Promise<CaseRow[]> {
    const result = await query<CaseRow>(
        `SELECT * FROM mod_cases WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
        [guildId, userId, page.limit, page.offset],
    );
    return result.rows;
}

export async function countUserCases(guildId: string, userId: string): Promise<number> {
    const result = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM mod_cases WHERE guild_id = $1 AND user_id = $2`, [
        guildId,
        userId,
    ]);
    return Number(result.rows[0]?.count ?? 0);
}

/** Warns that still count: not ended and not past their expiry. */
export async function activeWarns(guildId: string, userId: string, now: Date): Promise<CaseRow[]> {
    const result = await query<CaseRow>(
        `SELECT * FROM mod_cases
         WHERE guild_id = $1 AND user_id = $2 AND kind = 'warn' AND ended_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
         ORDER BY created_at, id`,
        [guildId, userId, now],
    );
    return result.rows;
}

export async function activeOfKind(guildId: string, userId: string, kind: CaseKind): Promise<CaseRow[]> {
    const result = await query<CaseRow>(
        `SELECT * FROM mod_cases WHERE guild_id = $1 AND user_id = $2 AND kind = $3 AND ended_at IS NULL ORDER BY created_at, id`,
        [guildId, userId, kind],
    );
    return result.rows;
}

/** Ends a case that is still open; `null` when it was already ended or does not exist. */
export async function endCase(
    id: string,
    end: { reason: EndReason; by: string | null; note: string | null; at: Date },
): Promise<CaseRow | null> {
    const result = await query<CaseRow>(
        `UPDATE mod_cases SET ended_at = $2, end_reason = $3, ended_by = $4, end_note = $5
         WHERE id = $1 AND ended_at IS NULL RETURNING *`,
        [id, end.at, end.reason, end.by, end.note],
    );
    return result.rows[0] ?? null;
}

/** Undoes `endCase` when the closing action failed and the worker will try again. */
export async function reopenCase(id: string): Promise<void> {
    await query(`UPDATE mod_cases SET ended_at = NULL, end_reason = NULL, ended_by = NULL, end_note = NULL WHERE id = $1`, [id]);
}

export async function updateReason(id: string, reason: string): Promise<CaseRow | null> {
    const result = await query<CaseRow>(`UPDATE mod_cases SET reason = $2 WHERE id = $1 RETURNING *`, [id, reason]);
    return result.rows[0] ?? null;
}

export async function setDmDelivered(id: string, delivered: boolean): Promise<void> {
    await query(`UPDATE mod_cases SET dm_delivered = $2 WHERE id = $1`, [id, delivered]);
}

export async function insertEvent(event: {
    caseId: string;
    kind: CaseEventKind;
    byId: string | null;
    data?: Record<string, unknown>;
    at?: Date;
}): Promise<CaseEventRow> {
    const result = await query<CaseEventRow>(
        `INSERT INTO mod_case_events (case_id, kind, by_id, data, at) VALUES ($1, $2, $3, $4, COALESCE($5, NOW())) RETURNING *`,
        [event.caseId, event.kind, event.byId, JSON.stringify(event.data ?? {}), event.at ?? null],
    );
    return result.rows[0] as CaseEventRow;
}

export async function listEvents(caseId: string): Promise<CaseEventRow[]> {
    const result = await query<CaseEventRow>(`SELECT * FROM mod_case_events WHERE case_id = $1 ORDER BY id`, [caseId]);
    return result.rows;
}

/** Open cases whose expiry has passed, oldest first. */
export async function dueCases(now: Date, limit: number): Promise<CaseRow[]> {
    const result = await query<CaseRow>(
        `SELECT * FROM mod_cases WHERE ended_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`,
        [now, limit],
    );
    return result.rows;
}

export interface StaffStatRow {
    kind: CaseKind;
    /** True for Cases the bot created itself (Auto-Punishment). */
    bot: boolean;
    count: number;
}

/** Cases created per kind. `moderatorId` null covers all staff plus the bot; `since` null is all time. */
export async function staffStats(guildId: string, moderatorId: string | null, since: Date | null): Promise<StaffStatRow[]> {
    const result = await query<{ kind: CaseKind; bot: boolean; count: string }>(
        `SELECT kind, (moderator_id IS NULL) AS bot, COUNT(*) AS count FROM mod_cases
         WHERE guild_id = $1 AND ($2::text IS NULL OR moderator_id = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
         GROUP BY kind, (moderator_id IS NULL)`,
        [guildId, moderatorId, since],
    );
    return result.rows.map((row) => ({ kind: row.kind, bot: row.bot, count: Number(row.count) }));
}
