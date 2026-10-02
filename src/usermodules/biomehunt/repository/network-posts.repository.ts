import { query } from "@/database/connection";
import type {
    NetworkAlertKind,
    NetworkAlertRow,
    NetworkBallotRow,
    NetworkMirrorRow,
    NetworkPostRow,
    NetworkVoteStatus,
    VoteChoice,
} from "../types";

export interface InsertNetworkPostParams {
    id: string;
    originGuildId: string;
    originName: string;
    originIconUrl: string | null;
    inviteUrl: string | null;
    eventId: number | null;
    finderDiscordId: string;
    biome: string;
    serverLink: string;
    serverCode: string;
    publishAt: Date;
    /** A test relay - stored with its vote already closed (`inconclusive`) so it never opens one. */
    simulated?: boolean;
    /** A test post's only destinations - omit for a real post (every member). */
    relayGuildIds?: string[] | null;
}

export async function insertNetworkPost(p: InsertNetworkPostParams): Promise<NetworkPostRow> {
    const result = await query<NetworkPostRow>(
        `INSERT INTO bh_network_posts (id, origin_guild_id, origin_name, origin_icon_url, invite_url, event_id, finder_discord_id, biome,
                                       server_link, server_code, publish_at, simulated, relay_guild_ids, vote_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $12 THEN 'inconclusive' ELSE 'open' END)
         RETURNING *`,
        [
            p.id,
            p.originGuildId,
            p.originName,
            p.originIconUrl,
            p.inviteUrl,
            p.eventId,
            p.finderDiscordId,
            p.biome,
            p.serverLink,
            p.serverCode,
            p.publishAt,
            p.simulated ?? false,
            p.relayGuildIds ?? null,
        ],
    );
    return result.rows[0];
}

export async function getNetworkPost(id: string): Promise<NetworkPostRow | null> {
    const result = await query<NetworkPostRow>(`SELECT * FROM bh_network_posts WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
}

/** Every non-discarded post of `biome` created since `since` - what deduplication compares a new find against. */
export async function getRecentNetworkPosts(biome: string, since: Date): Promise<NetworkPostRow[]> {
    const result = await query<NetworkPostRow>(
        `SELECT * FROM bh_network_posts WHERE biome = $1 AND created_at >= $2 AND status <> 'discarded' ORDER BY created_at`,
        [biome, since],
    );
    return result.rows;
}

export async function getDuePendingPosts(now: Date): Promise<NetworkPostRow[]> {
    const result = await query<NetworkPostRow>(
        `SELECT * FROM bh_network_posts WHERE status = 'pending' AND publish_at <= $1 ORDER BY publish_at`,
        [now],
    );
    return result.rows;
}

/** Posts still `publishing` although they were due before `before` - the bot died mid fan-out. */
export async function getStalePublishingPosts(before: Date): Promise<NetworkPostRow[]> {
    const result = await query<NetworkPostRow>(`SELECT * FROM bh_network_posts WHERE status = 'publishing' AND publish_at < $1`, [before]);
    return result.rows;
}

/** Compare-and-set `pending` → `publishing` - `false` means another tick already took it. */
export async function claimNetworkPost(id: string): Promise<boolean> {
    const result = await query(`UPDATE bh_network_posts SET status = 'publishing' WHERE id = $1 AND status = 'pending'`, [id]);
    return (result.rowCount ?? 0) > 0;
}

export async function markNetworkPostPublished(id: string, publishedAt: Date, voteClosesAt: Date): Promise<void> {
    await query(`UPDATE bh_network_posts SET status = 'published', published_at = $2, vote_closes_at = $3 WHERE id = $1`, [
        id,
        publishedAt,
        voteClosesAt,
    ]);
}

export async function markNetworkPostDiscarded(id: string): Promise<void> {
    await query(`UPDATE bh_network_posts SET status = 'discarded' WHERE id = $1 AND status IN ('pending', 'publishing')`, [id]);
}

export async function insertNetworkMirror(m: NetworkMirrorRow): Promise<void> {
    await query(
        `INSERT INTO bh_network_mirrors (post_id, guild_id, channel_id, message_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (post_id, guild_id) DO NOTHING`,
        [m.post_id, m.guild_id, m.channel_id, m.message_id],
    );
}

export async function getNetworkMirrors(postId: string): Promise<NetworkMirrorRow[]> {
    const result = await query<NetworkMirrorRow>(`SELECT * FROM bh_network_mirrors WHERE post_id = $1`, [postId]);
    return result.rows;
}

export type InsertNetworkBallotResult = "inserted" | "already_voted" | "closed";

/**
 * One ballot, atomically conditioned on the post's vote still being open (same pattern as
 * `insertBallot` in votes.repository.ts). The (post, user) primary key is "one vote per person -
 * the server you clicked in first counts".
 */
export async function insertNetworkBallot(
    postId: string,
    discordUserId: string,
    guildId: string,
    choice: VoteChoice,
): Promise<InsertNetworkBallotResult> {
    const result = await query<{ inserted: boolean; still_open: boolean }>(
        `WITH ins AS (
             INSERT INTO bh_network_ballots (post_id, discord_user_id, guild_id, choice)
             SELECT $1, $2, $3, $4
             WHERE EXISTS (SELECT 1 FROM bh_network_posts WHERE id = $1 AND status IN ('publishing', 'published') AND vote_status = 'open')
             ON CONFLICT (post_id, discord_user_id) DO NOTHING
             RETURNING 1
         )
         SELECT EXISTS(SELECT 1 FROM ins) AS inserted,
                EXISTS(SELECT 1 FROM bh_network_posts WHERE id = $1 AND status IN ('publishing', 'published') AND vote_status = 'open') AS still_open`,
        [postId, discordUserId, guildId, choice],
    );
    const row = result.rows[0];
    if (row?.inserted) return "inserted";
    return row?.still_open ? "already_voted" : "closed";
}

export async function getNetworkBallots(postId: string): Promise<NetworkBallotRow[]> {
    const result = await query<NetworkBallotRow>(`SELECT * FROM bh_network_ballots WHERE post_id = $1`, [postId]);
    return result.rows;
}

export async function getDueOpenNetworkVotes(now: Date): Promise<NetworkPostRow[]> {
    const result = await query<NetworkPostRow>(
        `SELECT * FROM bh_network_posts WHERE status = 'published' AND vote_status = 'open' AND vote_closes_at <= $1`,
        [now],
    );
    return result.rows;
}

/** Compare-and-set close: `null` means it was already closed (the worker and an owner raced) - apply nothing. */
export async function closeNetworkVoteRow(id: string, status: NetworkVoteStatus, closedBy: string | null): Promise<NetworkPostRow | null> {
    const result = await query<NetworkPostRow>(
        `UPDATE bh_network_posts SET vote_status = $2, vote_closed_by = $3
         WHERE id = $1 AND status = 'published' AND vote_status = 'open'
         RETURNING *`,
        [id, status, closedBy],
    );
    return result.rows[0] ?? null;
}

export interface InsertNetworkAlertParams {
    kind: NetworkAlertKind;
    guildId: string | null;
    discordUserId: string | null;
    postId: string | null;
    details: string;
    notified: boolean;
}

export async function insertNetworkAlert(a: InsertNetworkAlertParams): Promise<void> {
    await query(
        `INSERT INTO bh_network_alerts (kind, guild_id, discord_user_id, post_id, details, notified) VALUES ($1, $2, $3, $4, $5, $6)`,
        [a.kind, a.guildId, a.discordUserId, a.postId, a.details, a.notified],
    );
}

export async function hasNetworkAlert(kind: NetworkAlertKind, discordUserId: string): Promise<boolean> {
    const result = await query(`SELECT 1 FROM bh_network_alerts WHERE kind = $1 AND discord_user_id = $2 LIMIT 1`, [kind, discordUserId]);
    return (result.rowCount ?? 0) > 0;
}

export async function getUnnotifiedNetworkAlerts(kind: NetworkAlertKind): Promise<NetworkAlertRow[]> {
    const result = await query<NetworkAlertRow>(
        `SELECT * FROM bh_network_alerts WHERE kind = $1 AND notified = FALSE ORDER BY created_at`,
        [kind],
    );
    return result.rows;
}

export async function markNetworkAlertsNotified(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await query(`UPDATE bh_network_alerts SET notified = TRUE WHERE id = ANY($1::bigint[])`, [ids]);
}

/** The latest alerts about a guild or a user (whichever is given), newest first. */
export async function getRecentNetworkAlerts(
    filter: { guildId?: string; discordUserId?: string },
    limit: number,
): Promise<NetworkAlertRow[]> {
    const result = await query<NetworkAlertRow>(
        `SELECT * FROM bh_network_alerts
         WHERE ($1::varchar IS NULL OR guild_id = $1) AND ($2::varchar IS NULL OR discord_user_id = $2)
         ORDER BY created_at DESC LIMIT $3`,
        [filter.guildId ?? null, filter.discordUserId ?? null, limit],
    );
    return result.rows;
}
