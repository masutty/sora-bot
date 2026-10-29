import { query } from "@/database/connection";
import type { VoteHistoryKind, VoteHistoryRow } from "../types";

export interface InsertVoteHistoryParams {
    kind: VoteHistoryKind;
    voteId: string;
    fromStatus: string;
    toStatus: string;
    /** `null` when the ballots decided it. */
    byDiscordId: string | null;
}

export async function insertVoteHistory(p: InsertVoteHistoryParams): Promise<void> {
    await query(`INSERT INTO bh_vote_history (kind, vote_id, from_status, to_status, by_discord_id) VALUES ($1, $2, $3, $4, $5)`, [
        p.kind,
        p.voteId,
        p.fromStatus,
        p.toStatus,
        p.byDiscordId,
    ]);
}

/** Every result change of one vote, oldest first. */
export async function getVoteHistory(kind: VoteHistoryKind, voteId: string): Promise<VoteHistoryRow[]> {
    const result = await query<VoteHistoryRow>(`SELECT * FROM bh_vote_history WHERE kind = $1 AND vote_id = $2 ORDER BY created_at, id`, [
        kind,
        voteId,
    ]);
    return result.rows;
}
