import { getSessionsCovering, type RecordedEvent } from "../repository/activity.repository";
import { getCasualTally, getCasualVoteByJumpLink } from "../repository/casual-votes.repository";
import { getNetworkBallots, getNetworkMirrors, getNetworkPostByEventId } from "../repository/network-posts.repository";
import { getRewardsByEventIds } from "../repository/rewards.repository";
import { getBallotsForVote, getLatestVoteByEventId, getVoteByJumpLink } from "../repository/votes.repository";
import {
    type ActivitySessionRow,
    type BiomeRewardRow,
    type BiomeVoteRow,
    type CasualVoteRow,
    type NetworkPostRow,
    VoteChoice,
} from "../types";

/** How far a session's edges may be from a message's time and still hold it: the two are written moments apart. */
const SESSION_SLACK_MS = 60_000;

export interface Tally {
    real: number;
    fake: number;
}

/** Everything that happened because of one macro message. */
export interface FindRecord {
    session: ActivitySessionRow | null;
    reward: BiomeRewardRow | null;
    vote: { row: BiomeVoteRow; tally: Tally } | null;
    casual: { row: CasualVoteRow; tally: Tally } | null;
    network: { post: NetworkPostRow; tally: Tally; mirrors: number } | null;
}

const tallyOf = (ballots: ReadonlyArray<{ choice: VoteChoice }>): Tally => {
    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    return { real, fake: ballots.length - real };
};

/**
 * `jumpLink` is the macro message's link, which its forward votes keep. A vote is looked up by it
 * too, because an admin's Deny removes the event but leaves the vote.
 */
export async function loadFindRecord(
    jumpLink: string,
    recorded: RecordedEvent | null,
    userId: number | null,
    /** The message's own time: finds the session of a report that stored no biome event (a merchant, a Normal biome). */
    messageAt: Date,
): Promise<FindRecord> {
    const at = recorded?.received_at ?? messageAt;
    const [sessions, rewards, vote, casualRow, post] = await Promise.all([
        userId !== null
            ? getSessionsCovering(userId, new Date(at.getTime() - SESSION_SLACK_MS), new Date(at.getTime() + SESSION_SLACK_MS))
            : [],
        recorded ? getRewardsByEventIds([recorded.id]) : [],
        (async () => (recorded ? await getLatestVoteByEventId(recorded.id) : null) ?? (await getVoteByJumpLink(jumpLink)))(),
        getCasualVoteByJumpLink(jumpLink),
        recorded ? getNetworkPostByEventId(recorded.id) : null,
    ]);

    return {
        session: sessions[0] ?? null,
        reward: rewards[0] ?? null,
        vote: vote ? { row: vote, tally: tallyOf(await getBallotsForVote(vote.id)) } : null,
        casual: casualRow ? { row: casualRow, tally: await getCasualTally(casualRow.id) } : null,
        network: post
            ? { post, tally: tallyOf(await getNetworkBallots(post.id)), mirrors: (await getNetworkMirrors(post.id)).length }
            : null,
    };
}
