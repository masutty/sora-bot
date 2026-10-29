import { query } from "@/database/connection";
import { COUNTED_FIND_SQL } from "./users.repository";

export type LeaderboardMetric = "rares" | "hours" | "seeds";

/** Days each period reaches back - `null` for all time. */
export const LEADERBOARD_PERIOD_DAYS = { week: 7, month: 30, all: null } as const;
export type LeaderboardPeriod = keyof typeof LEADERBOARD_PERIOD_DAYS;

export interface LeaderboardRow {
    discordUserId: string;
    /** Counted rare finds, macro seconds or Seeds earned. */
    value: number;
}

/** `$1` = guild, `$2` = days (NULL for all time), `$3` = the rare biomes (Rares only). Every query returns `discord_user_id` and `value`, zero values skipped. */
const SQL: Record<LeaderboardMetric, string> = {
    rares: `SELECT u.discord_user_id, COUNT(*) AS value
            FROM bh_activity_events e
            JOIN bh_users u ON u.id = e.user_id
            WHERE u.guild_id = $1 AND e.event_type = 'started' AND e.biome = ANY($3) AND ${COUNTED_FIND_SQL}
              AND ($2::int IS NULL OR e.received_at >= NOW() - $2::int * INTERVAL '1 day')
            GROUP BY u.discord_user_id`,
    hours: `SELECT u.discord_user_id,
                   SUM(CASE WHEN $2::int IS NULL THEN s.duration_seconds
                            ELSE GREATEST(0, EXTRACT(EPOCH FROM s.ended_at - GREATEST(s.started_at, NOW() - $2::int * INTERVAL '1 day'))) END) AS value
            FROM bh_activity_sessions s
            JOIN bh_users u ON u.id = s.user_id
            WHERE u.guild_id = $1
            GROUP BY u.discord_user_id`,
    seeds: `SELECT u.discord_user_id, SUM(r.seeds_awarded) AS value
            FROM bh_biome_rewards r
            JOIN bh_users u ON u.id = r.user_id
            WHERE u.guild_id = $1
              AND ($2::int IS NULL OR r.awarded_at >= NOW() - $2::int * INTERVAL '1 day')
            GROUP BY u.discord_user_id`,
};

/**
 * A server's members ranked by `metric` over `period` (rolling window), best first, ties by Discord id, zero values left out.
 * Rares counts finds of `rareBiomes` by the event's time; Hours clips sessions to the window; Seeds sums what finds awarded.
 */
export async function getLeaderboard(
    guildId: string,
    metric: LeaderboardMetric,
    period: LeaderboardPeriod,
    rareBiomes: string[],
): Promise<LeaderboardRow[]> {
    const days = LEADERBOARD_PERIOD_DAYS[period];
    const result = await query<{ discord_user_id: string; value: string | null }>(
        `SELECT discord_user_id, value FROM (${SQL[metric]}) ranked
         WHERE COALESCE(value, 0) > 0
         ORDER BY value DESC, discord_user_id ASC`,
        metric === "rares" ? [guildId, days, rareBiomes] : [guildId, days],
    );
    return result.rows.map((r) => ({ discordUserId: r.discord_user_id, value: Math.floor(Number(r.value)) })).filter((r) => r.value > 0);
}
