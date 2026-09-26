import type { PoolClient } from "pg";
import { query } from "@/database/connection";
import type { Badge, BiomeRewardRow, UserRow } from "../types";

export interface InsertRewardParams {
    eventId: number;
    userId: number;
    biome: string;
    seeds: number;
    xp: number;
    badge: Badge | null;
}

export async function insertReward(client: PoolClient, params: InsertRewardParams): Promise<void> {
    await client.query(
        `INSERT INTO bh_biome_rewards (event_id, user_id, biome, seeds_awarded, xp_awarded, badge_awarded)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [params.eventId, params.userId, params.biome, params.seeds, params.xp, params.badge],
    );
}

/** Ledger rows for a set of event ids (e.g. the ones an admin is about to delete) - empty array if none of them were ever rewarded. */
export async function getRewardsByEventIds(eventIds: number[]): Promise<BiomeRewardRow[]> {
    if (eventIds.length === 0) return [];
    const result = await query<BiomeRewardRow>(
        `SELECT * FROM bh_biome_rewards WHERE event_id = ANY($1)`,
        [eventIds],
    );
    return result.rows;
}

/** How many ledger rows still credit this user with this specific badge - used to decide whether reverting one event should also revoke the badge (only if this drops to 0). */
export async function countRewardsWithBadge(userId: number, badge: Badge): Promise<number> {
    const result = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM bh_biome_rewards WHERE user_id = $1 AND badge_awarded = $2`,
        [userId, badge],
    );
    return Number(result.rows[0]?.count ?? 0);
}

export interface UnrewardedEvent {
    id: number;
    biome: string;
}

/**
 * Confirmed (`started`, non-null biome) events for a user that DON'T yet have a `bh_biome_rewards`
 * row - i.e. biome finds that predate the economy being turned on, or were otherwise missed.
 * `afterDate`/`biomes` are optional narrowing filters (`null` = no restriction on that axis); used
 * by `bh-owner recalculate-user`'s backfill, which is additive only - it never touches an event
 * that already has a ledger row.
 */
export async function getUnrewardedEventsForUser(
    userId: number,
    afterDate: Date | null,
    biomes: string[] | null,
): Promise<UnrewardedEvent[]> {
    const result = await query<UnrewardedEvent>(
        `SELECT e.id, e.biome
         FROM bh_activity_events e
         LEFT JOIN bh_biome_rewards r ON r.event_id = e.id
         WHERE e.user_id = $1 AND e.event_type = 'started' AND e.biome IS NOT NULL AND r.event_id IS NULL
           AND ($2::timestamptz IS NULL OR e.received_at >= $2)
           AND ($3::text[] IS NULL OR e.biome = ANY($3))
         ORDER BY e.received_at ASC`,
        [userId, afterDate, biomes],
    );
    return result.rows;
}

const ADJUST_BALANCE_SQL = `UPDATE bh_users SET seeds = GREATEST(0, seeds + $2), xp = GREATEST(0, xp + $3) WHERE id = $1 RETURNING *`;

/** Applies a Seeds/XP delta (either sign), floored at 0. Runs inside `client`'s transaction when given one (grant/revert paths), or standalone (the admin manual-adjustment command). */
export async function adjustUserBalance(client: PoolClient | null, userId: number, seedsDelta: number, xpDelta: number): Promise<UserRow> {
    const params = [userId, seedsDelta, xpDelta];
    const result = client
        ? await client.query<UserRow>(ADJUST_BALANCE_SQL, params)
        : await query<UserRow>(ADJUST_BALANCE_SQL, params);
    return result.rows[0];
}
