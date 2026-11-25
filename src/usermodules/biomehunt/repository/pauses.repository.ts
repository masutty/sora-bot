import type { PoolClient } from "pg";
import { query, transaction } from "@/database/connection";

export type PauseKind = "forced" | "self";
export type PauseNotify = "now" | "session_end";
export type PauseEndReason = "member" | "admin" | "expired" | "session_end" | "replaced";
export type PauseUntil = { kind: "interaction" } | { kind: "session_end" } | { kind: "time"; at: Date };

export interface PauseRow {
    id: number;
    user_id: number;
    kind: PauseKind;
    message: string | null;
    by_discord_id: string | null;
    counts: boolean;
    notify: PauseNotify;
    until: PauseUntil;
    notice_sent_at: Date | null;
    started_at: Date;
    ended_at: Date | null;
    ended_reason: PauseEndReason | null;
}

/** The raw bh_pauses row: until_kind/until_at fold into `until`, and BIGSERIAL ids arrive as strings. */
type PauseDbRow = Omit<PauseRow, "until"> & { until_kind: PauseUntil["kind"]; until_at: Date | null };

export function toPauseRow(r: PauseDbRow): PauseRow {
    const { until_kind, until_at, ...rest } = r;
    let until: PauseUntil = { kind: "interaction" };
    if (until_kind === "session_end") until = { kind: "session_end" };
    else if (until_kind === "time") {
        if (!until_at) throw new Error(`bh_pauses row ${r.id} has until_kind 'time' but no until_at`);
        until = { kind: "time", at: until_at };
    }
    return { ...rest, id: Number(r.id), user_id: Number(r.user_id), until };
}

/** Ends a still-active pause matched by `where`, clears the member's paused_at and restarts their auto-delete clock. */
async function endActive(client: PoolClient, where: string, param: number, reason: PauseEndReason): Promise<PauseRow | null> {
    // Serialize per member, so a concurrent createPause/end cannot trip the one-active unique index.
    await client.query(
        `SELECT id FROM bh_users WHERE id = (SELECT user_id FROM bh_pauses WHERE ${where} AND ended_at IS NULL) FOR UPDATE`,
        [param],
    );
    const result = await client.query<PauseDbRow>(
        `UPDATE bh_pauses SET ended_at = NOW(), ended_reason = $2 WHERE ${where} AND ended_at IS NULL RETURNING *`,
        [param, reason],
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query(`UPDATE bh_users SET paused_at = NULL, auto_delete_clock_from = NOW() WHERE id = $1`, [row.user_id]);
    return toPauseRow(row);
}

export async function createPause(input: {
    userId: number;
    kind: PauseKind;
    message: string | null;
    byDiscordId: string | null;
    counts: boolean;
    notify: PauseNotify;
    until: PauseUntil;
}): Promise<PauseRow> {
    return transaction(async (client) => {
        await client.query(`SELECT id FROM bh_users WHERE id = $1 FOR UPDATE`, [input.userId]);
        // A replaced pause does not restart the auto-delete clock: the member stays paused.
        await client.query(`UPDATE bh_pauses SET ended_at = NOW(), ended_reason = 'replaced' WHERE user_id = $1 AND ended_at IS NULL`, [
            input.userId,
        ]);
        const result = await client.query<PauseDbRow>(
            `INSERT INTO bh_pauses (user_id, kind, message, by_discord_id, counts, notify, until_kind, until_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                input.userId,
                input.kind,
                input.message,
                input.byDiscordId,
                input.counts,
                input.notify,
                input.until.kind,
                input.until.kind === "time" ? input.until.at : null,
            ],
        );
        await client.query(`UPDATE bh_users SET paused_at = NOW() WHERE id = $1`, [input.userId]);
        return toPauseRow(result.rows[0]);
    });
}

export async function endActivePause(userId: number, reason: PauseEndReason): Promise<PauseRow | null> {
    return transaction((client) => endActive(client, "user_id = $1", userId, reason));
}

export async function endPauseById(pauseId: number, reason: PauseEndReason): Promise<PauseRow | null> {
    return transaction((client) => endActive(client, "id = $1", pauseId, reason));
}

export async function getActivePause(userId: number): Promise<PauseRow | null> {
    const result = await query<PauseDbRow>(`SELECT * FROM bh_pauses WHERE user_id = $1 AND ended_at IS NULL`, [userId]);
    return result.rows[0] ? toPauseRow(result.rows[0]) : null;
}

export async function getPauseById(pauseId: number): Promise<PauseRow | null> {
    const result = await query<PauseDbRow>(`SELECT * FROM bh_pauses WHERE id = $1`, [pauseId]);
    return result.rows[0] ? toPauseRow(result.rows[0]) : null;
}

export async function markNoticeSent(pauseId: number): Promise<void> {
    await query(`UPDATE bh_pauses SET notice_sent_at = NOW() WHERE id = $1`, [pauseId]);
}

export async function getDueTimedPauses(now: Date): Promise<PauseRow[]> {
    const result = await query<PauseDbRow>(
        `SELECT * FROM bh_pauses WHERE ended_at IS NULL AND until_kind = 'time' AND until_at <= $1 ORDER BY until_at`,
        [now],
    );
    return result.rows.map(toPauseRow);
}
