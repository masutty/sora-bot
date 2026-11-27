import type { PoolClient } from "pg";
import { query } from "@/database/connection";

export interface MerchantEventRow {
    id: number;
    user_id: number;
    discord_message_id: string;
    merchant: string;
    macro_type: string | null;
    server_link: string | null;
    received_at: Date;
}

export interface InsertMerchantEventParams {
    userId: number;
    discordMessageId: string;
    merchant: string;
    macroType: string | null;
    serverLink: string | null;
}

/**
 * Records a merchant find, unless the member already has one for this merchant in the last
 * `dedupS` seconds (a macro reports one arrival more than once) or the message was already
 * recorded. `null` when nothing was stored.
 */
export async function insertMerchantEventIfNew(params: InsertMerchantEventParams, dedupS: number): Promise<number | null> {
    const result = await query<{ id: string }>(
        `INSERT INTO bh_merchant_events (user_id, discord_message_id, merchant, macro_type, server_link)
         SELECT $1::int, $2::varchar, $3::varchar, $4::varchar, $5::text
         WHERE NOT EXISTS (
             SELECT 1 FROM bh_merchant_events
             WHERE user_id = $1::int AND merchant = $3::varchar AND received_at > NOW() - make_interval(secs => $6)
         )
         ON CONFLICT (discord_message_id) DO NOTHING
         RETURNING id`,
        [params.userId, params.discordMessageId, params.merchant, params.macroType, params.serverLink, dedupS],
    );
    return result.rows[0] ? Number(result.rows[0].id) : null;
}

export async function getMerchantEventByMessageId(discordMessageId: string): Promise<MerchantEventRow | null> {
    const result = await query<MerchantEventRow>(`SELECT * FROM bh_merchant_events WHERE discord_message_id = $1`, [discordMessageId]);
    return result.rows[0] ?? null;
}

export async function merchantEventExists(eventId: number): Promise<boolean> {
    const result = await query(`SELECT 1 FROM bh_merchant_events WHERE id = $1`, [eventId]);
    return (result.rowCount ?? 0) > 0;
}

const counts = (rows: Array<{ merchant: string; count: string }>) => rows.map((r) => ({ merchant: r.merchant, count: Number(r.count) }));

/** A member's finds per merchant, most found first. */
export async function getMerchantCounts(userId: number): Promise<Array<{ merchant: string; count: number }>> {
    const result = await query<{ merchant: string; count: string }>(
        `SELECT merchant, COUNT(*) AS count FROM bh_merchant_events WHERE user_id = $1 GROUP BY merchant ORDER BY count DESC`,
        [userId],
    );
    return counts(result.rows);
}

export async function getMerchantCountsInRange(
    userId: number,
    start: Date,
    end: Date,
): Promise<Array<{ merchant: string; count: number }>> {
    const result = await query<{ merchant: string; count: string }>(
        `SELECT merchant, COUNT(*) AS count FROM bh_merchant_events
         WHERE user_id = $1 AND received_at >= $2 AND received_at <= $3
         GROUP BY merchant ORDER BY count DESC`,
        [userId, start, end],
    );
    return counts(result.rows);
}

export async function getMerchantCountForUser(userId: number, merchant: string): Promise<number> {
    const result = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM bh_merchant_events WHERE user_id = $1 AND merchant = $2`, [
        userId,
        merchant,
    ]);
    return Number(result.rows[0]?.count ?? 0);
}

/** The server's finds of a merchant, and when the last one other than `excludeEventId` happened. */
export async function getGuildMerchantFindStats(
    guildId: string,
    merchant: string,
    excludeEventId: number | null,
): Promise<{ count: number; lastFoundAt: Date | null }> {
    const result = await query<{ count: string; last_found_at: Date | null }>(
        `SELECT COUNT(*) AS count, MAX(e.received_at) FILTER (WHERE e.id IS DISTINCT FROM $3) AS last_found_at
         FROM bh_merchant_events e
         JOIN bh_users u ON u.id = e.user_id
         WHERE u.guild_id = $1 AND e.merchant = $2`,
        [guildId, merchant, excludeEventId],
    );
    return { count: Number(result.rows[0]?.count ?? 0), lastFoundAt: result.rows[0]?.last_found_at ?? null };
}

/** Removes a member's merchant finds, inside the caller's transaction. */
export async function deleteMerchantEventsForUser(client: PoolClient, userId: number): Promise<void> {
    await client.query(`DELETE FROM bh_merchant_events WHERE user_id = $1`, [userId]);
}
