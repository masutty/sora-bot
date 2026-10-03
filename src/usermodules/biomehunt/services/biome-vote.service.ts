import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { newTraceRef } from "@/utils/trace";
import { BIOME_META } from "../constants/biomes.constants";
import { deleteEventById } from "../repository/activity.repository";
import { getRewardsByEventIds } from "../repository/rewards.repository";
import { getUserById } from "../repository/users.repository";
import { closeVote, getBallotsForVote, getOpenVotesPastClose, getVoteById, insertBallot, insertVote } from "../repository/votes.repository";
import { settings } from "../settings";
import type { BiomeVoteBallotRow, BiomeVoteRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { buildForwardContainer, type VoteRenderInfo } from "../views/forward-post.view";
import { grantBiomeReward, revertBiomeRewards, revokeOrphanedBadges } from "./biome-reward.service";

const logger = new Logger("biomehunt.services.biome-vote");

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
 * The render info for `vote`'s CURRENT status - `open` hides the tally (just a live count);
 * anything else shows the real/fake split and, for an admin decision, who decided. Shared by
 * every call site so a re-read right before rendering (see `castBallot`) always renders whichever
 * state it actually finds, not an assumption baked in earlier.
 */
function renderInfoFor(vote: BiomeVoteRow, ballots: Array<Pick<BiomeVoteBallotRow, "choice">>): VoteRenderInfo {
    if (vote.status === VoteStatus.OPEN) {
        return { voteId: vote.id, status: VoteStatus.OPEN, closesAt: vote.closes_at, voteCount: ballots.length };
    }
    return {
        voteId: vote.id,
        status: vote.status,
        closesAt: vote.closes_at,
        voteCount: ballots.length,
        tally: tallyOf(ballots),
        decidedByUserId: vote.decided_by ?? undefined,
    };
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
    eventId: number | null;
    finderUserId: number;
    channelId: string;
    messageId: string;
    biome: string;
    /**
     * The forward message's own render inputs, captured now and persisted verbatim - never
     * re-derived later (see `updateVoteContainer`'s docstring for why).
     */
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    findCount?: number | null;
    finderDiscordId?: string | null;
    serverFindCount?: number | null;
    lastSeenInServerAt?: Date | null;
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
        roleId: params.roleId,
        serverLink: params.serverLink,
        jumpLink: params.jumpLink,
        findCount: params.findCount ?? null,
        finderDiscordId: params.finderDiscordId ?? null,
        serverFindCount: params.serverFindCount ?? null,
        lastSeenInServerAt: params.lastSeenInServerAt ?? null,
        closesAt,
    });
}

/**
 * Grants the outcome exactly once - `community_real`/`admin_confirmed` grant the reward only if
 * this event doesn't already have one (an admin later re-confirming, e.g. via `/bh-admin review`,
 * must never double-grant); `admin_denied` reverts whatever was granted (safe/no-op if nothing
 * was) and deletes the event, mirroring the existing admin-deny behavior. `no_votes`/`tie`/
 * `community_fake` do nothing - the event is kept for a possible later admin review.
 *
 * A `null` `event_id` (a PRIOR admin deny already deleted the event - `bh_biome_votes.event_id`
 * is `ON DELETE SET NULL`, not cascaded away) short-circuits everything: there's no event left to
 * credit or debit, so a later flip-flop (e.g. confirming after denying) is a pure status change.
 */
async function applyOutcome(vote: BiomeVoteRow, deps: VoteServiceDeps): Promise<void> {
    const eventId = vote.event_id;
    if (eventId === null) return;

    if (vote.status === VoteStatus.COMMUNITY_REAL || vote.status === VoteStatus.ADMIN_CONFIRMED) {
        const existing = await deps.getRewardsByEventIds([eventId]);
        if (existing.length === 0) {
            await deps.grantBiomeReward(vote.guild_id, vote.finder_user_id, eventId, vote.biome);
        }
        return;
    }

    if (vote.status === VoteStatus.ADMIN_DENIED) {
        // Must run BEFORE the event is deleted - revertBiomeRewards reads the ledger row, which
        // would otherwise cascade away the moment the event itself is gone.
        const { badgeCandidates } = await deps.revertBiomeRewards(vote.finder_user_id, [eventId]);
        await deps.deleteEventById(eventId);
        await deps.revokeOrphanedBadges(vote.guild_id, vote.finder_user_id, badgeCandidates);
    }
}

/**
 * Applies the outcome, logging (rather than throwing) if it fails - by this point `vote`'s CAS
 * close has ALREADY committed, so a failure here must never look like the vote itself failed to
 * close: it did, just without its grant/revert applied yet. The log line names `/bh-admin review`
 * as the recovery path (re-deciding the same way re-applies the outcome, since `applyOutcome` is
 * itself idempotent).
 */
async function applyOutcomeSafely(vote: BiomeVoteRow, deps: VoteServiceDeps): Promise<void> {
    try {
        await applyOutcome(vote, deps);
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), {
            voteId: vote.id,
            note: `Vote ${vote.id} closed as ${vote.status} but its outcome failed to apply - re-apply via /bh-admin review ${vote.id}`,
        });
    }
}

/** Fetches the vote's own forward message, or `null` if the channel/message is gone (best-effort - a missing message never fails the caller). */
async function fetchVoteMessage(client: BotClient, vote: BiomeVoteRow) {
    const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;
    return channel.messages.fetch(vote.message_id).catch(() => null);
}

/**
 * Rebuilds the forward message from `vote`'s OWN stored render inputs (role_id/server_link/
 * jump_link/find_count/finder_discord_id/server_find_count/last_seen_in_server_at) - never from the message's own currently-rendered components, and never
 * re-derived from `bh_biome_forwards`/the macro's parsed text/a live recount, none of which are
 * guaranteed to still match what the ORIGINAL message showed by the time this runs.
 */
async function refreshVoteMessage(client: BotClient, vote: BiomeVoteRow, render: VoteRenderInfo): Promise<void> {
    const message = await fetchVoteMessage(client, vote);
    if (!message) return;

    const container = buildForwardContainer({
        biome: vote.biome,
        flavorText: BIOME_META[vote.biome]?.flavorText,
        roleId: vote.role_id,
        serverLink: vote.server_link,
        jumpLink: vote.jump_link,
        finderDiscordId: vote.finder_discord_id,
        findCount: vote.find_count,
        serverFindCount: vote.server_find_count,
        lastSeenInServerAt: vote.last_seen_in_server_at,
        vote: render,
    });
    // An edit never re-pings, but be explicit: the finder/deciding admin are only ever named, never pinged.
    await message.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS }).catch(() => {});
}

export type CastBallotResult = { kind: "ok" } | { kind: "not_found" } | { kind: "closed" } | { kind: "finder" } | { kind: "already_voted" };

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

    // Atomic: the INSERT itself is conditioned on the vote still being open, closing the race
    // window between the `getVoteById` read above and this write (a `closeDueVotes`/`adminDecide`
    // closing the vote in between yields "closed" here, not a recorded ballot on a dead vote).
    const insertResult = await deps.insertBallot(voteId, discordUserId, choice);
    if (insertResult === "already_voted") return { kind: "already_voted" };
    if (insertResult === "closed") return { kind: "closed" };

    // Re-read the vote right before rendering - it may have closed in the tiny window between the
    // insert above and this refresh (an admin decision, or the closing worker). Rendering the
    // OPEN state unconditionally here would overwrite an already-closed message with a stale
    // "N votes • closes <t:R>" - `renderInfoFor` picks the right shape for whatever status this
    // finds, open or not.
    const current = (await deps.getVoteById(voteId)) ?? vote;
    const ballots = await deps.getBallotsForVote(voteId);
    await refreshVoteMessage(client, current, renderInfoFor(current, ballots));

    return { kind: "ok" };
}

export type AdminDecideResult =
    | { kind: "ok"; status: VoteStatus.ADMIN_CONFIRMED | VoteStatus.ADMIN_DENIED }
    | { kind: "not_found" }
    | { kind: "already_decided" };

/**
 * An admin's decisive click - real (confirm) or fake (deny), inside OR after the vote's window
 * (an admin overriding a closed vote later, e.g. via `/bh-admin review`, still goes through here).
 * An admin CAN decide on their own find: the admin's word outranks the "no self-vote" rule, which
 * only applies to community ballots (`castBallot`). The close itself is a compare-and-set on the status
 * this call just read (`vote.status`): if another decision (a racing admin click, or
 * `closeDueVotes`) already changed it in the meantime, `deps.closeVote` returns `null` and this
 * reports `already_decided` WITHOUT applying any outcome - that's what keeps a close tick racing
 * an admin click, or two admins clicking at once, from double-granting or double-reverting.
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
    const closed = await deps.closeVote(voteId, vote.status, status, adminDiscordId);
    if (!closed) return { kind: "already_decided" };

    await applyOutcomeSafely(closed, deps);

    // Read AFTER the close committed - any ballot racing the close is now either reflected here
    // (it landed before the commit) or cleanly rejected by insertBallot's own atomicity (after).
    const ballots = await deps.getBallotsForVote(voteId);
    await refreshVoteMessage(client, closed, renderInfoFor(closed, ballots));

    return { kind: "ok", status };
}

/**
 * Resolves every vote whose window has elapsed - called every 5s by `workers/vote-close.worker.ts`,
 * which also covers a vote left `open` by a restart (there's no in-memory state to lose anymore).
 * Each vote is handled independently (its own try/catch, logged with its id) so one failure never
 * skips the rest of the tick. The close itself is a compare-and-set expecting `open` - if an admin
 * already decided this vote between the scan (`getOpenVotesPastClose`) and this write, `closeVote`
 * returns `null` and the resolved outcome (reward grant, in particular) is never applied.
 */
export async function closeDueVotes(
    client: BotClient,
    now: Date = new Date(),
    deps: VoteServiceDeps = defaultVoteServiceDeps(),
): Promise<void> {
    const due = await deps.getOpenVotesPastClose(now);

    for (const vote of due) {
        try {
            const preCloseBallots = await deps.getBallotsForVote(vote.id);
            const status = resolveVote(preCloseBallots);
            const closed = await deps.closeVote(vote.id, VoteStatus.OPEN, status, null);
            if (!closed) continue; // an admin already decided it - don't apply this outcome too

            await applyOutcomeSafely(closed, deps);

            // Read AFTER the close committed, not the pre-close snapshot used to pick `status` -
            // a ballot racing the close is now either reflected here (it landed before the commit)
            // or cleanly rejected by insertBallot's own atomicity (after), so the message always
            // shows a count/tally consistent with what's actually in the DB right now.
            const ballots = await deps.getBallotsForVote(vote.id);
            await refreshVoteMessage(client, closed, renderInfoFor(closed, ballots));
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { voteId: vote.id });
        }
    }
}
