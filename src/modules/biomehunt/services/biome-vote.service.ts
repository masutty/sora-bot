import type { APIContainerComponent } from "discord.js";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { newTraceRef } from "@/utils/trace";
import { deleteEventById } from "../repository/activity.repository";
import { getRewardsByEventIds } from "../repository/rewards.repository";
import { getUserById } from "../repository/users.repository";
import {
    closeVote, getBallotsForVote, getOpenVotesPastClose, getVoteById, insertBallot, insertVote,
} from "../repository/votes.repository";
import { settings } from "../settings";
import type { BiomeVoteBallotRow, BiomeVoteRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { updateVoteContainer, type VoteRenderInfo } from "../views/forward-post.view";
import { grantBiomeReward, revertBiomeRewards, revokeOrphanedBadges } from "./biome-reward.service";

/**
 * Everything this service would otherwise call directly on the DB/reward ledger, injected so its
 * tests never touch either - `defaultVoteServiceDeps` wires the real functions.
 */
export interface VoteServiceDeps {
    insertVote: typeof insertVote;
    getVoteById: typeof getVoteById;
    getOpenVotesPastClose: typeof getOpenVotesPastClose;
    insertBallot: typeof insertBallot;
    getBallotsForVote: typeof getBallotsForVote;
    closeVote: typeof closeVote;
    getUserById: typeof getUserById;
    getRewardsByEventIds: typeof getRewardsByEventIds;
    grantBiomeReward: typeof grantBiomeReward;
    revertBiomeRewards: typeof revertBiomeRewards;
    revokeOrphanedBadges: typeof revokeOrphanedBadges;
    deleteEventById: typeof deleteEventById;
}

export function defaultVoteServiceDeps(): VoteServiceDeps {
    return {
        insertVote,
        getVoteById,
        getOpenVotesPastClose,
        insertBallot,
        getBallotsForVote,
        closeVote,
        getUserById,
        getRewardsByEventIds,
        grantBiomeReward,
        revertBiomeRewards,
        revokeOrphanedBadges,
        deleteEventById,
    };
}

/** Short random code for a new vote - same shape as a trace `ref` (8 lowercase base36 chars), not sequential so it can't be guessed. */
export function newVoteId(): string {
    return newTraceRef();
}

/**
 * The pure heart of the vote model: no votes / tie / majority. `NO_VOTES` and `TIE` are distinct -
 * 0×0 is "no votes", not a tie. Exhaustively unit-tested; every other status (`open`,
 * `admin_confirmed`, `admin_denied`) is never a resolver output, only ever set explicitly by
 * `adminDecide`.
 */
export function resolveVote(
    ballots: Array<Pick<BiomeVoteBallotRow, "choice">>,
): VoteStatus.NO_VOTES | VoteStatus.TIE | VoteStatus.COMMUNITY_REAL | VoteStatus.COMMUNITY_FAKE {
    if (ballots.length === 0) return VoteStatus.NO_VOTES;

    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    const fake = ballots.length - real;
    if (real === fake) return VoteStatus.TIE;
    return real > fake ? VoteStatus.COMMUNITY_REAL : VoteStatus.COMMUNITY_FAKE;
}

function tallyOf(ballots: Array<Pick<BiomeVoteBallotRow, "choice">>): { real: number; fake: number } {
    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    return { real, fake: ballots.length - real };
}

/**
 * Registers a rare-biome forward's community vote - replaces the old in-memory `startVoteCheck`.
 * The caller (`forward.service.ts`) generates `voteId` itself (via `newVoteId`) BEFORE sending the
 * message, so the message can show it right away; this just persists the row once the message's
 * own `channelId`/`messageId` are known.
 */
export interface OpenVoteParams {
    voteId: string;
    guildId: string;
    eventId: number;
    finderUserId: number;
    channelId: string;
    messageId: string;
    biome: string;
    /** Injectable for tests - defaults to now. */
    now?: Date;
}

export async function openVote(params: OpenVoteParams, deps: VoteServiceDeps = defaultVoteServiceDeps()): Promise<BiomeVoteRow> {
    const now = params.now ?? new Date();
    const closesAt = new Date(now.getTime() + settings.votes.windowMs);
    return deps.insertVote({
        id: params.voteId,
        guildId: params.guildId,
        eventId: params.eventId,
        finderUserId: params.finderUserId,
        channelId: params.channelId,
        messageId: params.messageId,
        biome: params.biome,
        closesAt,
    });
}

/**
 * Grants the outcome exactly once - `community_real`/`admin_confirmed` grant the reward only if
 * this event doesn't already have one (an admin later re-confirming, e.g. via `/bh-admin review`,
 * must never double-grant); `admin_denied` reverts whatever was granted (safe/no-op if nothing
 * was) and deletes the event, mirroring the existing admin-deny behavior. `no_votes`/`tie`/
 * `community_fake` do nothing - the event is kept for a possible later admin review.
 */
async function applyOutcome(vote: BiomeVoteRow, deps: VoteServiceDeps): Promise<void> {
    if (vote.status === VoteStatus.COMMUNITY_REAL || vote.status === VoteStatus.ADMIN_CONFIRMED) {
        const existing = await deps.getRewardsByEventIds([vote.event_id]);
        if (existing.length === 0) {
            await deps.grantBiomeReward(vote.guild_id, vote.finder_user_id, vote.event_id, vote.biome);
        }
        return;
    }

    if (vote.status === VoteStatus.ADMIN_DENIED) {
        // Must run BEFORE the event is deleted - revertBiomeRewards reads the ledger row, which
        // cascades away the moment the event itself is gone.
        const { badgeCandidates } = await deps.revertBiomeRewards(vote.finder_user_id, [vote.event_id]);
        await deps.deleteEventById(vote.event_id);
        await deps.revokeOrphanedBadges(vote.guild_id, vote.finder_user_id, badgeCandidates);
    }
}

/** Fetches the vote's own forward message, or `null` if the channel/message is gone (best-effort - a missing message never fails the caller). */
async function fetchVoteMessage(client: BotClient, vote: BiomeVoteRow) {
    const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;
    return channel.messages.fetch(vote.message_id).catch(() => null);
}

async function refreshVoteMessage(client: BotClient, vote: BiomeVoteRow, render: VoteRenderInfo): Promise<void> {
    const message = await fetchVoteMessage(client, vote);
    if (!message) return;

    const raw = message.components[0]?.toJSON() as APIContainerComponent | undefined;
    if (!raw) return;

    const container = updateVoteContainer(raw, render);
    await message.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
}

export type CastBallotResult =
    | { kind: "ok" }
    | { kind: "not_found" }
    | { kind: "closed" }
    | { kind: "finder" }
    | { kind: "already_voted" };

/**
 * Casts one community ballot. Rejects the finder voting on their own find, a duplicate vote (no
 * changing an existing one), and a vote that's already closed. On success, re-edits the forward
 * message with the new (still-hidden) tally count.
 */
export async function castBallot(
    client: BotClient,
    voteId: string,
    discordUserId: string,
    choice: VoteChoice,
    deps: VoteServiceDeps = defaultVoteServiceDeps(),
): Promise<CastBallotResult> {
    const vote = await deps.getVoteById(voteId);
    if (!vote) return { kind: "not_found" };
    if (vote.status !== VoteStatus.OPEN) return { kind: "closed" };

    const finder = await deps.getUserById(vote.finder_user_id);
    if (finder?.discord_user_id === discordUserId) return { kind: "finder" };

    const inserted = await deps.insertBallot(voteId, discordUserId, choice);
    if (!inserted) return { kind: "already_voted" };

    const ballots = await deps.getBallotsForVote(voteId);
    await refreshVoteMessage(client, vote, {
        voteId: vote.id,
        status: VoteStatus.OPEN,
        closesAt: vote.closes_at,
        voteCount: ballots.length,
    });

    return { kind: "ok" };
}

export type AdminDecideResult =
    | { kind: "ok"; status: VoteStatus.ADMIN_CONFIRMED | VoteStatus.ADMIN_DENIED }
    | { kind: "not_found" };

/**
 * An admin's decisive click - real (confirm) or fake (deny), inside OR after the vote's window
 * (an admin overriding a closed vote later, e.g. via `/bh-admin review`, still goes through here).
 * Always overrides whatever the vote's current status is and closes it for good.
 */
export async function adminDecide(
    client: BotClient,
    voteId: string,
    adminDiscordId: string,
    choice: VoteChoice,
    deps: VoteServiceDeps = defaultVoteServiceDeps(),
): Promise<AdminDecideResult> {
    const vote = await deps.getVoteById(voteId);
    if (!vote) return { kind: "not_found" };

    const status = choice === VoteChoice.REAL ? VoteStatus.ADMIN_CONFIRMED : VoteStatus.ADMIN_DENIED;
    const closed = await deps.closeVote(voteId, status, adminDiscordId);
    await applyOutcome(closed, deps);
    await refreshVoteMessage(client, closed, {
        voteId: closed.id,
        status: closed.status,
        closesAt: closed.closes_at,
        voteCount: 0,
        decidedByUserId: adminDiscordId,
    });

    return { kind: "ok", status };
}

/**
 * Resolves every vote whose window has elapsed - called every 5s by `workers/vote-close.worker.ts`,
 * which also covers a vote left `open` by a restart (there's no in-memory state to lose anymore).
 */
export async function closeDueVotes(client: BotClient, now: Date = new Date(), deps: VoteServiceDeps = defaultVoteServiceDeps()): Promise<void> {
    const due = await deps.getOpenVotesPastClose(now);

    for (const vote of due) {
        const ballots = await deps.getBallotsForVote(vote.id);
        const status = resolveVote(ballots);
        const closed = await deps.closeVote(vote.id, status, null);
        await applyOutcome(closed, deps);

        const tally = tallyOf(ballots);
        await refreshVoteMessage(client, closed, {
            voteId: closed.id,
            status: closed.status,
            closesAt: closed.closes_at,
            voteCount: ballots.length,
            tally,
        });
    }
}
