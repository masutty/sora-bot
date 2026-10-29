import { query } from "@/database/connection";
import type { BallotWriteResult, BiomeVoteBallotRow, BiomeVoteRow, VoteChoice, VoteStatus } from "../types";

export interface InsertVoteParams {
    id: string;
    guildId: string;
    eventId: number | null;
    finderUserId: number;
    channelId: string;
    messageId: string;
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    findCount: number | null;
    finderDiscordId: string | null;
    serverFindCount: number | null;
    lastSeenInServerAt: Date | null;
    closesAt: Date;
}

export async function insertVote(params: InsertVoteParams): Promise<BiomeVoteRow> {
    const result = await query<BiomeVoteRow>(
        `INSERT INTO bh_biome_votes (id, guild_id, event_id, finder_user_id, channel_id, message_id, biome, role_id, server_link, jump_link, find_count,
                                     finder_discord_id, server_find_count, last_seen_in_server_at, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
            params.id,
            params.guildId,
            params.eventId,
            params.finderUserId,
            params.channelId,
            params.messageId,
            params.biome,
            params.roleId,
            params.serverLink,
            params.jumpLink,
            params.findCount,
            params.finderDiscordId,
            params.serverFindCount,
            params.lastSeenInServerAt,
            params.closesAt,
        ],
    );
    return result.rows[0];
}

export async function getVoteById(voteId: string): Promise<BiomeVoteRow | null> {
    const result = await query<BiomeVoteRow>(`SELECT * FROM bh_biome_votes WHERE id = $1`, [voteId]);
    return result.rows[0] ?? null;
}

/** Every still-`open` vote whose window has already elapsed by `now` - what `closeDueVotes` resolves each tick, including anything left open by a restart. */
export async function getOpenVotesPastClose(now: Date): Promise<BiomeVoteRow[]> {
    const result = await query<BiomeVoteRow>(`SELECT * FROM bh_biome_votes WHERE status = 'open' AND closes_at <= $1`, [now]);
    return result.rows;
}

/**
 * Writes one ballot ATOMICALLY conditioned on the vote still being `open` (the `WHERE EXISTS`
 * subquery inside the same statement as the write - a `closeDueVotes`/`adminDecide` closing the
 * vote between an earlier "is it open?" read and this write makes it a no-op). A voter's second
 * click on the other choice switches it once (`changed` marks that); any later switch, or the
 * same choice again, writes nothing. The trailing `SELECT` reads the pre-statement row to tell
 * those apart from a closed vote.
 */
export async function insertBallot(voteId: string, userId: string, choice: VoteChoice): Promise<BallotWriteResult> {
    const result = await query<{ inserted: boolean | null; still_open: boolean; previous: VoteChoice | null }>(
        `WITH up AS (
             INSERT INTO bh_biome_vote_ballots (vote_id, user_id, choice)
             SELECT $1, $2, $3
             WHERE EXISTS (SELECT 1 FROM bh_biome_votes WHERE id = $1 AND status = 'open')
             ON CONFLICT (vote_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, changed = TRUE
                 WHERE bh_biome_vote_ballots.choice <> EXCLUDED.choice AND NOT bh_biome_vote_ballots.changed
             RETURNING (xmax = 0) AS inserted
         )
         SELECT (SELECT inserted FROM up) AS inserted,
                EXISTS(SELECT 1 FROM bh_biome_votes WHERE id = $1 AND status = 'open') AS still_open,
                (SELECT choice FROM bh_biome_vote_ballots WHERE vote_id = $1 AND user_id = $2) AS previous`,
        [voteId, userId, choice],
    );
    return ballotWriteResult(result.rows[0], choice);
}

/** Shared by both vote kinds' ballot writes - see `insertBallot`. */
export function ballotWriteResult(
    row: { inserted: boolean | null; still_open: boolean; previous: VoteChoice | null } | undefined,
    choice: VoteChoice,
): BallotWriteResult {
    if (row?.inserted === true) return "inserted";
    if (row?.inserted === false) return "changed";
    if (!row?.still_open) return "closed";
    return row.previous === choice ? "unchanged" : "change_locked";
}

export async function getBallotsForVote(voteId: string): Promise<BiomeVoteBallotRow[]> {
    const result = await query<BiomeVoteBallotRow>(`SELECT * FROM bh_biome_vote_ballots WHERE vote_id = $1`, [voteId]);
    return result.rows;
}

/** Marks the vote's fake-find report as sent - `true` only for the call that wins, so a report goes out once per vote. */
export async function markFakeReported(voteId: string): Promise<boolean> {
    const result = await query<{ id: string }>(
        `UPDATE bh_biome_votes SET fake_reported_at = NOW() WHERE id = $1 AND fake_reported_at IS NULL RETURNING id`,
        [voteId],
    );
    return result.rows.length > 0;
}

/**
 * Compare-and-set close: only actually closes the vote (and stamps `decided_at`) if its status is
 * STILL `expectedStatus` (whatever the caller read just before deciding) - `null` otherwise,
 * meaning someone else (a racing admin click, or `closeDueVotes`) already decided it first. The
 * caller MUST treat `null` as a no-op and skip applying any outcome (reward grant/revert) - this
 * is what makes a close tick racing an admin click, or two admins clicking at once, apply the
 * outcome exactly once instead of double-granting/double-reverting.
 */
export async function closeVote(
    voteId: string,
    expectedStatus: VoteStatus,
    status: VoteStatus,
    decidedBy: string | null,
): Promise<BiomeVoteRow | null> {
    const result = await query<BiomeVoteRow>(
        `UPDATE bh_biome_votes SET status = $3, decided_by = $4, decided_at = NOW()
         WHERE id = $1 AND status = $2
         RETURNING *`,
        [voteId, expectedStatus, status, decidedBy],
    );
    return result.rows[0] ?? null;
}

/** The server's newest rare-find votes. */
export async function getRecentGuildVotes(guildId: string, limit: number): Promise<BiomeVoteRow[]> {
    const result = await query<BiomeVoteRow>(`SELECT * FROM bh_biome_votes WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2`, [
        guildId,
        limit,
    ]);
    return result.rows;
}

/** The vote a forward message in `guildId` carries. */
export async function getVoteByMessage(guildId: string, messageId: string): Promise<BiomeVoteRow | null> {
    const result = await query<BiomeVoteRow>(`SELECT * FROM bh_biome_votes WHERE guild_id = $1 AND message_id = $2`, [guildId, messageId]);
    return result.rows[0] ?? null;
}

/** The newest vote opened on an event - `null` when the find had none. */
export async function getLatestVoteByEventId(eventId: number): Promise<BiomeVoteRow | null> {
    const result = await query<BiomeVoteRow>(`SELECT * FROM bh_biome_votes WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`, [
        eventId,
    ]);
    return result.rows[0] ?? null;
}

/** One vote in the admin review queue, with what the queue needs to say why it is there. */
export interface ReviewQueueRow {
    id: string;
    biome: string;
    finderDiscordId: string | null;
    createdAt: Date;
    status: VoteStatus;
    real: number;
    fake: number;
    /** An earlier vote of the same finder in this server ended fake. */
    finderHadFake: boolean;
}

/**
 * The server's votes from the last 7 days that closed without an admin's decision and look worth a
 * second check: a tie, no votes, a verdict won by one ballot, or a finder with an earlier Fake Find.
 * A vote an admin already looked at (a history row with a `by_discord_id`, e.g. "Looks fine") is
 * left out. Newest first.
 */
export async function getReviewQueue(guildId: string): Promise<ReviewQueueRow[]> {
    const result = await query<{
        id: string;
        biome: string;
        finder_discord_id: string | null;
        created_at: Date;
        status: VoteStatus;
        real_count: number;
        fake_count: number;
        finder_had_fake: boolean;
    }>(
        `SELECT q.id, q.biome, q.finder_discord_id, q.created_at, q.status, q.real_count, q.fake_count, q.finder_had_fake
         FROM (
             SELECT v.id, v.biome, v.created_at, v.status,
                    COALESCE(v.finder_discord_id, (SELECT u.discord_user_id FROM bh_users u WHERE u.id = v.finder_user_id)) AS finder_discord_id,
                    (SELECT COUNT(*) FROM bh_biome_vote_ballots b WHERE b.vote_id = v.id AND b.choice = 'real')::int AS real_count,
                    (SELECT COUNT(*) FROM bh_biome_vote_ballots b WHERE b.vote_id = v.id AND b.choice = 'fake')::int AS fake_count,
                    EXISTS (
                        SELECT 1 FROM bh_biome_votes p
                        WHERE p.guild_id = v.guild_id AND p.finder_user_id = v.finder_user_id AND p.created_at < v.created_at
                          AND p.status IN ('community_fake', 'admin_denied')
                    ) AS finder_had_fake
             FROM bh_biome_votes v
             WHERE v.guild_id = $1
               AND v.created_at > NOW() - INTERVAL '7 days'
               AND v.status IN ('tie', 'no_votes', 'community_real', 'community_fake')
               AND NOT EXISTS (
                   SELECT 1 FROM bh_vote_history h WHERE h.kind = 'local' AND h.vote_id = v.id AND h.by_discord_id IS NOT NULL
               )
         ) q
         WHERE q.status IN ('tie', 'no_votes') OR ABS(q.real_count - q.fake_count) = 1 OR q.finder_had_fake
         ORDER BY q.created_at DESC`,
        [guildId],
    );
    return result.rows.map((r) => ({
        id: r.id,
        biome: r.biome,
        finderDiscordId: r.finder_discord_id,
        createdAt: r.created_at,
        status: r.status,
        real: r.real_count,
        fake: r.fake_count,
        finderHadFake: r.finder_had_fake,
    }));
}
