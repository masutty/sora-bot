import { query } from "@/database/connection";
import type { BallotWriteResult, CasualVoteRow, VoteChoice } from "../types";
import { ballotWriteResult } from "./votes.repository";

export interface InsertCasualVoteParams {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    finderDiscordId: string | null;
    findCount: number | null;
    serverFindCount: number | null;
}

export async function insertCasualVote(params: InsertCasualVoteParams): Promise<CasualVoteRow> {
    const result = await query<CasualVoteRow>(
        `INSERT INTO bh_casual_votes (id, guild_id, channel_id, message_id, biome, role_id, server_link, jump_link,
                                      finder_discord_id, find_count, server_find_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
            params.id,
            params.guildId,
            params.channelId,
            params.messageId,
            params.biome,
            params.roleId,
            params.serverLink,
            params.jumpLink,
            params.finderDiscordId,
            params.findCount,
            params.serverFindCount,
        ],
    );
    return result.rows[0];
}

export async function getCasualVote(id: string): Promise<CasualVoteRow | null> {
    const result = await query<CasualVoteRow>(`SELECT * FROM bh_casual_votes WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
}

/**
 * Writes one ballot. A voter's second click on the other choice switches it once (`changed` marks
 * that); any later switch, or the same choice again, writes nothing. A casual vote never closes, so
 * the result is never `closed`.
 */
export async function insertCasualBallot(voteId: string, userId: string, choice: VoteChoice): Promise<BallotWriteResult> {
    const result = await query<{ inserted: boolean | null; still_open: boolean; previous: VoteChoice | null }>(
        `WITH up AS (
             INSERT INTO bh_casual_vote_ballots (vote_id, user_id, choice)
             VALUES ($1, $2, $3)
             ON CONFLICT (vote_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, changed = TRUE
                 WHERE bh_casual_vote_ballots.choice <> EXCLUDED.choice AND NOT bh_casual_vote_ballots.changed
             RETURNING (xmax = 0) AS inserted
         )
         SELECT (SELECT inserted FROM up) AS inserted,
                TRUE AS still_open,
                (SELECT choice FROM bh_casual_vote_ballots WHERE vote_id = $1 AND user_id = $2) AS previous`,
        [voteId, userId, choice],
    );
    return ballotWriteResult(result.rows[0], choice);
}

export async function getCasualTally(voteId: string): Promise<{ real: number; fake: number }> {
    const result = await query<{ real: string; fake: string }>(
        `SELECT COUNT(*) FILTER (WHERE choice = 'real') AS real, COUNT(*) FILTER (WHERE choice = 'fake') AS fake
         FROM bh_casual_vote_ballots WHERE vote_id = $1`,
        [voteId],
    );
    return { real: Number(result.rows[0]?.real ?? 0), fake: Number(result.rows[0]?.fake ?? 0) };
}
