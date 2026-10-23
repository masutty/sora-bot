import { type RareFind, VoteStatus } from "../types";

export interface VoteTally {
    real: number;
    fake: number;
}

export type VoteVerdict = "real" | "fake" | "tie" | "no_votes";

export interface VoteOutcome {
    verdict: VoteVerdict;
    tally: VoteTally;
    /** Discord id of whoever decided it with a click (an admin, or the bot owner) - unset when the ballots decided it. */
    decidedBy?: string | null;
    /** Who the ballots belong to, after "Marked as real by" - the local community by default. */
    voters?: string;
}

/**
 * The one line saying how a closed vote ended - shared by the forward post, the Network Mirror and
 * `/admin review-voting`, so the three never word an outcome differently.
 */
export function voteOutcomeLine(o: VoteOutcome): string {
    const chips = ` \`✅ ${o.tally.real}\` \`❌ ${o.tally.fake}\``;
    switch (o.verdict) {
        case "no_votes":
            return "*Vote expired with no votes*";
        case "tie":
            return `⚖️ Tied vote${chips}`;
        case "real":
            return o.decidedBy
                ? `✅ Marked as real by <@${o.decidedBy}>`
                : `✅ Marked as real by ${o.voters ?? "community voting"}${chips}`;
        case "fake":
            return o.decidedBy
                ? `❌ Marked as fake by <@${o.decidedBy}>`
                : `❌ Marked as fake by ${o.voters ?? "community voting"}${chips}`;
    }
}

/** A rare find's vote result as one short label for the history and session views - `""` when it had no vote. */
export function findResultLabel(vote: RareFind["vote"]): string {
    if (!vote) return "";
    switch (vote.status) {
        case VoteStatus.OPEN:
            return "⏳ Voting";
        case VoteStatus.NO_VOTES:
            return "No votes";
        case VoteStatus.TIE:
            return "⚖️ Tied";
        case VoteStatus.COMMUNITY_REAL:
            return "✅ Real";
        case VoteStatus.ADMIN_CONFIRMED:
            return `✅ Confirmed by <@${vote.decidedBy}>`;
        case VoteStatus.COMMUNITY_FAKE:
            return `❌ Fake \`✅ ${vote.real}\` \`❌ ${vote.fake}\``;
        case VoteStatus.ADMIN_DENIED:
            return `❌ Denied by <@${vote.decidedBy}>`;
    }
}

/** A closed local vote's status as a verdict - `open` has none. */
export function localVoteVerdict(status: Exclude<VoteStatus, VoteStatus.OPEN>): VoteVerdict {
    switch (status) {
        case VoteStatus.NO_VOTES:
            return "no_votes";
        case VoteStatus.TIE:
            return "tie";
        case VoteStatus.COMMUNITY_REAL:
        case VoteStatus.ADMIN_CONFIRMED:
            return "real";
        case VoteStatus.COMMUNITY_FAKE:
        case VoteStatus.ADMIN_DENIED:
            return "fake";
    }
}
