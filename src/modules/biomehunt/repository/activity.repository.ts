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
): Promise<number | null> {
    const result = await client.query<{ id: number }>(
        `INSERT INTO bh_activity_events (user_id, discord_message_id, biome, macro_type, event_type, event_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (discord_message_id) DO NOTHING
         RETURNING id`,
        [userId, discordMessageId, biome, macroType, eventType, eventTimestamp],
    );
    return result.rows[0]?.id ?? null;
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

/**
 * Sums the portion of each session that actually falls within the last `windowHours` - not the
 * full `duration_seconds` of every session that merely *started* inside the window. A long
 * session that started before the cutoff but is still running (or ended just after it) used to
 * be excluded entirely, undercounting active time right at the window boundary (this mattered
 * for quota role grants specifically).
 */
export async function getActiveSecondsInWindow(userId: number, windowHours: number): Promise<number> {
    const result = await query<{ total: string | null }>(
        `SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
             LEAST(ended_at, NOW()) - GREATEST(started_at, NOW() - ($2 || ' hours')::interval)
         )))) AS total
         FROM bh_activity_sessions
         WHERE user_id = $1 AND ended_at >= NOW() - ($2 || ' hours')::interval`,
        [userId, windowHours],
    );
    return Number(result.rows[0]?.total ?? 0);
}

/** Same clamped-overlap math as `getActiveSecondsInWindow`, but against an explicit `[start, end]`
 * range instead of a rolling "last N hours" one - used for the Quotas tab's "today" figure, whose
 * boundary is the guild's `quota_eval_hour_utc` rollover rather than a fixed lookback. */
export async function getActiveSecondsBetween(userId: number, start: Date, end: Date): Promise<number> {
    const result = await query<{ total: string | null }>(
        `SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
             LEAST(ended_at, $3) - GREATEST(started_at, $2)
         )))) AS total
         FROM bh_activity_sessions
         WHERE user_id = $1 AND ended_at >= $2 AND started_at <= $3`,
        [userId, start, end],
    );
    return Number(result.rows[0]?.total ?? 0);
}

export async function getLatestSessionForUser(userId: number): Promise<ActivitySessionRow | null> {
    const result = await query<ActivitySessionRow>(
        `SELECT * FROM bh_activity_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [userId],
    );
    return result.rows[0] ?? null;
}

/** Same as `getBiomeCounts`, but scoped to a single session's time range - used for the session-end report. */
export async function getBiomeCountsInRange(userId: number, start: Date, end: Date): Promise<Array<{ biome: string; count: number }>> {
    const result = await query<{ biome: string; count: string }>(
        `SELECT biome, COUNT(*) AS count
         FROM bh_activity_events
         WHERE user_id = $1 AND biome IS NOT NULL AND event_type = 'started'
           AND received_at >= $2 AND received_at <= $3
         GROUP BY biome
         ORDER BY count DESC`,
        [userId, start, end],
    );
    return result.rows.map((r) => ({ biome: r.biome, count: Number(r.count) }));
}

export async function getRecentSessions(userId: number, limit: number): Promise<ActivitySessionRow[]> {
    const result = await query<ActivitySessionRow>(
        `SELECT * FROM bh_activity_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [userId, limit],
    );
    return result.rows;
}

/** Deletes one specific session (scoped to `userId` too, so an admin can't accidentally target another user's row by guessing an ID). Returns true iff a row was actually removed. */
export async function deleteSessionById(userId: number, sessionId: number): Promise<boolean> {
    const result = await query(`DELETE FROM bh_activity_sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
    return (result.rowCount ?? 0) > 0;
}

/** Wipes all session history for a user. Returns the number of sessions removed. */
export async function deleteAllSessionsForUser(userId: number): Promise<number> {
    const result = await query(`DELETE FROM bh_activity_sessions WHERE user_id = $1`, [userId]);
    return result.rowCount ?? 0;
}

/**
 * Removes the `amount` most recently recorded "started" events for a biome - decrements the
 * count `getBiomeCounts` reports without needing to touch any paired "ended" rows (those are
 * never counted). Returns the number of events actually removed.
 */
export async function decrementBiomeEvents(userId: number, biome: string, amount: number): Promise<number[]> {
    const result = await query<{ id: number }>(
        `DELETE FROM bh_activity_events
         WHERE id IN (
             SELECT id FROM bh_activity_events
             WHERE user_id = $1 AND biome = $2 AND event_type = 'started'
             ORDER BY received_at DESC
             LIMIT $3
         )
         RETURNING id`,
        [userId, biome, amount],
    );
    return result.rows.map((r) => r.id);
}

/** Removes every recorded event (both "started" and "ended") for a biome, fully resetting its count to 0. */
export async function clearBiomeEvents(userId: number, biome: string): Promise<number[]> {
    const result = await query<{ id: number }>(
        `DELETE FROM bh_activity_events WHERE user_id = $1 AND biome = $2 RETURNING id`,
        [userId, biome],
    );
    return result.rows.map((r) => r.id);
}

/** Deletes a single event by id - used by the rare-biome vote check's Deny button, which needs the report to fully disappear (not just get relabeled). */
export async function deleteEventById(eventId: number): Promise<void> {
    await query(`DELETE FROM bh_activity_events WHERE id = $1`, [eventId]);
}

/** Total confirmed "started" finds of one specific biome for a user - used to show "this is the #N <biome> they found!" on forwards. */
export async function getBiomeCountForUser(userId: number, biome: string): Promise<number> {
    const result = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bh_activity_events WHERE user_id = $1 AND biome = $2 AND event_type = 'started'`,
        [userId, biome],
    );
    return Number(result.rows[0]?.count ?? 0);
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
                SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(s.ended_at, NOW()) - GREATEST(s.started_at, NOW() - ($2 || ' hours')::interval)
                )))) AS active_seconds,
                COUNT(s.id) AS session_count
         FROM bh_users u
         JOIN bh_activity_sessions s ON s.user_id = u.id
         WHERE u.guild_id = $1 AND s.ended_at >= NOW() - ($2 || ' hours')::interval
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

/** Guild-wide version of `getBiomeCounts` - every confirmed "started" find across every member of the guild, keyed by biome. */
export async function getGuildBiomeCounts(guildId: string): Promise<Array<{ biome: string; count: number }>> {
    const result = await query<{ biome: string; count: string }>(
        `SELECT e.biome, COUNT(*) AS count
         FROM bh_activity_events e
         JOIN bh_users u ON u.id = e.user_id
         WHERE u.guild_id = $1 AND e.biome IS NOT NULL AND e.event_type = 'started'
         GROUP BY e.biome
         ORDER BY count DESC`,
        [guildId],
    );
    return result.rows.map((r) => ({ biome: r.biome, count: Number(r.count) }));
}

/** For every biome the guild has ever found, the single member with the most confirmed finds of
 * it (ties broken arbitrarily by Postgres) - one row per biome via a per-biome rank window. */
export async function getBiomeTopContributors(guildId: string): Promise<Array<{ biome: string; discordUserId: string; count: number }>> {
    const result = await query<{ biome: string; discord_user_id: string; count: string }>(
        `SELECT biome, discord_user_id, count FROM (
             SELECT e.biome, u.discord_user_id, COUNT(*) AS count,
                    ROW_NUMBER() OVER (PARTITION BY e.biome ORDER BY COUNT(*) DESC) AS rn
             FROM bh_activity_events e
             JOIN bh_users u ON u.id = e.user_id
             WHERE u.guild_id = $1 AND e.biome IS NOT NULL AND e.event_type = 'started'
             GROUP BY e.biome, u.discord_user_id
         ) ranked
         WHERE rn = 1
         ORDER BY count DESC`,
        [guildId],
    );
    return result.rows.map((r) => ({ biome: r.biome, discordUserId: r.discord_user_id, count: Number(r.count) }));
}

export interface GuildSessionOverview {
    totalSessions: number;
    totalSeconds: number;
    avgSeconds: number;
    distinctUsers: number;
}

/** Aggregate session stats across the whole guild - total sessions logged, total/average time spent, and how many distinct members have ever logged one. */
export async function getGuildSessionOverview(guildId: string): Promise<GuildSessionOverview> {
    const result = await query<{ total_sessions: string; total_seconds: string | null; avg_seconds: string | null; distinct_users: string }>(
        `SELECT COUNT(*) AS total_sessions,
                COALESCE(SUM(s.duration_seconds), 0) AS total_seconds,
                COALESCE(AVG(s.duration_seconds), 0) AS avg_seconds,
                COUNT(DISTINCT s.user_id) AS distinct_users
         FROM bh_activity_sessions s
         JOIN bh_users u ON u.id = s.user_id
         WHERE u.guild_id = $1`,
        [guildId],
    );
    const row = result.rows[0];
    return {
        totalSessions: Number(row?.total_sessions ?? 0),
        totalSeconds: Number(row?.total_seconds ?? 0),
        avgSeconds: Number(row?.avg_seconds ?? 0),
        distinctUsers: Number(row?.distinct_users ?? 0),
    };
}

export interface GuildSessionRow {
    id: number;
    discordUserId: string;
    started_at: Date;
    ended_at: Date;
    duration_seconds: number;
}

/** The `limit` longest single sessions ever logged in the guild, regardless of who logged them. */
export async function getLongestSessions(guildId: string, limit: number): Promise<GuildSessionRow[]> {
    const result = await query<{ id: number; discord_user_id: string; started_at: Date; ended_at: Date; duration_seconds: number }>(
        `SELECT s.id, u.discord_user_id, s.started_at, s.ended_at, s.duration_seconds
         FROM bh_activity_sessions s
         JOIN bh_users u ON u.id = s.user_id
         WHERE u.guild_id = $1
         ORDER BY s.duration_seconds DESC
         LIMIT $2`,
        [guildId, limit],
    );
    return result.rows.map((r) => ({
        id: r.id, discordUserId: r.discord_user_id, started_at: r.started_at, ended_at: r.ended_at, duration_seconds: r.duration_seconds,
    }));
}

/** Where a user's single longest session ranks against every other session in the guild (1 = the longest session anyone has ever logged). `null` if they have no sessions at all. */
export async function getUserLongestSessionRank(guildId: string, userId: number): Promise<{ rank: number; totalSessions: number; longestSeconds: number } | null> {
    const longest = await query<{ duration_seconds: number }>(
        `SELECT MAX(duration_seconds) AS duration_seconds FROM bh_activity_sessions WHERE user_id = $1`,
        [userId],
    );
    const longestSeconds = longest.rows[0]?.duration_seconds;
    if (longestSeconds === null || longestSeconds === undefined) return null;

    const result = await query<{ rank: string; total: string }>(
        `SELECT
             (SELECT COUNT(*) + 1 FROM bh_activity_sessions s2 JOIN bh_users u2 ON u2.id = s2.user_id
              WHERE u2.guild_id = $1 AND s2.duration_seconds > $2) AS rank,
             (SELECT COUNT(*) FROM bh_activity_sessions s3 JOIN bh_users u3 ON u3.id = s3.user_id
              WHERE u3.guild_id = $1) AS total`,
        [guildId, longestSeconds],
    );
    return { rank: Number(result.rows[0].rank), totalSessions: Number(result.rows[0].total), longestSeconds };
}

