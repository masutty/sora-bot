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
    closesAt: Date;
}

export async function insertVote(params: InsertVoteParams): Promise<BiomeVoteRow> {
    const result = await query<BiomeVoteRow>(
        `INSERT INTO bh_biome_votes (id, guild_id, event_id, finder_user_id, channel_id, message_id, biome, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [params.id, params.guildId, params.eventId, params.finderUserId, params.channelId, params.messageId, params.biome, params.closesAt],
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

/** Inserts one ballot - `ON CONFLICT DO NOTHING` on (vote_id, user_id) is the "no changing" rule: a second vote from the same user is silently rejected, never overwritten. Returns whether it was actually recorded. */
export async function insertBallot(voteId: string, userId: string, choice: VoteChoice): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_biome_vote_ballots (vote_id, user_id, choice)
         VALUES ($1, $2, $3)
         ON CONFLICT (vote_id, user_id) DO NOTHING`,
        [voteId, userId, choice],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getBallotsForVote(voteId: string): Promise<BiomeVoteBallotRow[]> {
    const result = await query<BiomeVoteBallotRow>(`SELECT * FROM bh_biome_vote_ballots WHERE vote_id = $1`, [voteId]);
    return result.rows;
}

/** Closes a vote (or overrides a previous close - `/bh-admin review` may decide after the fact), stamping `decided_at`. `decidedBy` is the admin's discord id, or `null` for a community/expiry resolution. */
export async function closeVote(voteId: string, status: VoteStatus, decidedBy: string | null): Promise<BiomeVoteRow> {
    const result = await query<BiomeVoteRow>(
        `UPDATE bh_biome_votes SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1 RETURNING *`,
        [voteId, status, decidedBy],
    );
    return result.rows[0];
}
