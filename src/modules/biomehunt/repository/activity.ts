import type { PoolClient } from "pg";
import { query } from "@/database/connection";
import type { ActivitySessionRow } from "../types";

export async function insertEventIfNew(
    client: PoolClient,
    userId: number,
    discordMessageId: string,
    biome: string | null,
    macroType: string | null,
    eventType: "started" | "ended" | null,
    eventTimestamp: Date | null,
): Promise<boolean> {
    const result = await client.query(
        `INSERT INTO bh_activity_events (user_id, discord_message_id, biome, macro_type, event_type, event_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (discord_message_id) DO NOTHING
         RETURNING id`,
        [userId, discordMessageId, biome, macroType, eventType, eventTimestamp],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getLatestSession(client: PoolClient, userId: number): Promise<ActivitySessionRow | null> {
    const result = await client.query<ActivitySessionRow>(
        `SELECT * FROM bh_activity_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [userId],
    );
    return result.rows[0] ?? null;
}

export async function openNewSession(client: PoolClient, userId: number, at: Date): Promise<ActivitySessionRow> {
    const result = await client.query<ActivitySessionRow>(
        `INSERT INTO bh_activity_sessions (user_id, started_at, ended_at, duration_seconds)
         VALUES ($1, $2, $2, 0)
         RETURNING *`,
        [userId, at],
    );
    return result.rows[0];
}

export async function extendSession(client: PoolClient, sessionId: number, at: Date): Promise<ActivitySessionRow> {
    const result = await client.query<ActivitySessionRow>(
        `UPDATE bh_activity_sessions
         SET ended_at = $2, duration_seconds = EXTRACT(EPOCH FROM ($2::timestamptz - started_at))::int
         WHERE id = $1
         RETURNING *`,
        [sessionId, at],
    );
    return result.rows[0];
}

export async function getActiveSecondsInWindow(userId: number, windowHours: number): Promise<number> {
    const result = await query<{ total: string | null }>(
        `SELECT SUM(duration_seconds) AS total
         FROM bh_activity_sessions
         WHERE user_id = $1 AND started_at >= NOW() - ($2 || ' hours')::interval`,
        [userId, windowHours],
    );
    return Number(result.rows[0]?.total ?? 0);
}

export async function getRecentSessions(userId: number, limit: number): Promise<ActivitySessionRow[]> {
    const result = await query<ActivitySessionRow>(
        `SELECT * FROM bh_activity_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [userId, limit],
    );
    return result.rows;
}

/** Counts confirmed "started" events only — each biome session sends both a started and ended message, and counting both would double the total. */
export async function getBiomeCounts(userId: number): Promise<Array<{ biome: string; count: number }>> {
    const result = await query<{ biome: string; count: string }>(
        `SELECT biome, COUNT(*) AS count
         FROM bh_activity_events
         WHERE user_id = $1 AND biome IS NOT NULL AND event_type = 'started'
         GROUP BY biome
         ORDER BY count DESC`,
        [userId],
    );
    return result.rows.map((r) => ({ biome: r.biome, count: Number(r.count) }));
}

export async function getLeaderboard(
    guildId: string,
    windowHours: number,
    limit: number,
): Promise<Array<{ discordUserId: string; activeSeconds: number; sessionCount: number }>> {
    const result = await query<{ discord_user_id: string; active_seconds: string | null; session_count: string }>(
        `SELECT u.discord_user_id,
                SUM(s.duration_seconds) AS active_seconds,
                COUNT(s.id) AS session_count
         FROM bh_users u
         JOIN bh_activity_sessions s ON s.user_id = u.id
         WHERE u.guild_id = $1 AND s.started_at >= NOW() - ($2 || ' hours')::interval
         GROUP BY u.discord_user_id
         ORDER BY active_seconds DESC
         LIMIT $3`,
        [guildId, windowHours, limit],
    );
    return result.rows.map((r) => ({
        discordUserId: r.discord_user_id,
        activeSeconds: Number(r.active_seconds ?? 0),
        sessionCount: Number(r.session_count),
    }));
}

