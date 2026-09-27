import { query } from "@/database/connection";
import type { BiomeVoteBallotRow, BiomeVoteRow, VoteChoice, VoteStatus } from "../types";

export interface InsertVoteParams {
    id: string;
    guildId: string;
    eventId: number;
    finderUserId: number;
    channelId: string;
    messageId: string;
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    findCount: number | null;
    closesAt: Date;
}

export async function insertVote(params: InsertVoteParams): Promise<BiomeVoteRow> {
    const result = await query<BiomeVoteRow>(
        `INSERT INTO bh_biome_votes (id, guild_id, event_id, finder_user_id, channel_id, message_id, biome, role_id, server_link, jump_link, find_count, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
            params.id, params.guildId, params.eventId, params.finderUserId, params.channelId, params.messageId,
            params.biome, params.roleId, params.serverLink, params.jumpLink, params.findCount, params.closesAt,
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
    const result = await query<BiomeVoteRow>(
        `SELECT * FROM bh_biome_votes WHERE status = 'open' AND closes_at <= $1`,
        [now],
    );
    return result.rows;
}

export type InsertBallotResult = "inserted" | "already_voted" | "closed";

/**
 * Inserts one ballot ATOMICALLY conditioned on the vote still being `open` (the `WHERE EXISTS`
 * subquery inside the same statement as the `INSERT` - closes the race window between an earlier
 * "is it open?" read and this write: a `closeDueVotes`/`adminDecide` closing the vote in between
 * makes this INSERT a no-op instead of recording a ballot on a vote that's no longer open).
 * `ON CONFLICT DO NOTHING` on (vote_id, user_id) is the "no changing" rule - a second vote from the
 * same user is silently rejected, never overwritten. The trailing `SELECT` distinguishes WHY
 * nothing was inserted: still open (so it must be a duplicate) vs. no longer open.
 */
export async function insertBallot(voteId: string, userId: string, choice: VoteChoice): Promise<InsertBallotResult> {
    const result = await query<{ inserted: boolean; still_open: boolean }>(
        `WITH ins AS (
             INSERT INTO bh_biome_vote_ballots (vote_id, user_id, choice)
             SELECT $1, $2, $3
             WHERE EXISTS (SELECT 1 FROM bh_biome_votes WHERE id = $1 AND status = 'open')
             ON CONFLICT (vote_id, user_id) DO NOTHING
             RETURNING 1
         )
         SELECT EXISTS(SELECT 1 FROM ins) AS inserted,
                EXISTS(SELECT 1 FROM bh_biome_votes WHERE id = $1 AND status = 'open') AS still_open`,
        [voteId, userId, choice],
    );
    const row = result.rows[0];
    if (row?.inserted) return "inserted";
    return row?.still_open ? "already_voted" : "closed";
}

export async function getBallotsForVote(voteId: string): Promise<BiomeVoteBallotRow[]> {
    const result = await query<BiomeVoteBallotRow>(`SELECT * FROM bh_biome_vote_ballots WHERE vote_id = $1`, [voteId]);
    return result.rows;
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
