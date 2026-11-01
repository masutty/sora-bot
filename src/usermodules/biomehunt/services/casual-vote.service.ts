import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { getBiomeMeta } from "../constants/biomes.constants";
import {
    getCasualTally,
    getCasualVote,
    type InsertCasualVoteParams,
    insertCasualBallot,
    insertCasualVote,
} from "../repository/casual-votes.repository";
import { type CasualVoteRow, type VoteChoice, VoteStatus } from "../types";
import { buildForwardContainer } from "../views/forward-post.view";

/** Customid prefix of the Real/Fake buttons on a regular forward - routed by `casual-vote.component.ts`. */
export const CASUAL_VOTE_PREFIX = "biomehunt:casual-vote";

/** What the casual vote would otherwise call on the DB, injected so its tests never touch it. */
export interface CasualVoteDeps {
    getCasualVote: typeof getCasualVote;
    insertCasualBallot: typeof insertCasualBallot;
    getCasualTally: typeof getCasualTally;
}

export function defaultCasualVoteDeps(): CasualVoteDeps {
    return { getCasualVote, insertCasualBallot, getCasualTally };
}

export const openCasualVote = (params: InsertCasualVoteParams): Promise<CasualVoteRow> => insertCasualVote(params);

/** The card of a regular forward with its live count - the same shape the live forward was sent with. */
export function casualVoteCard(vote: CasualVoteRow, tally: { real: number; fake: number }, sentAt?: Date) {
    return buildForwardContainer({
        biome: vote.biome,
        flavorText: getBiomeMeta(vote.biome)?.flavorText,
        roleId: vote.role_id,
        serverLink: vote.server_link,
        jumpLink: vote.jump_link,
        finderDiscordId: vote.finder_discord_id,
        findCount: vote.find_count,
        serverFindCount: vote.server_find_count,
        sentAt,
        vote: { voteId: vote.id, status: VoteStatus.OPEN, tally, prefix: CASUAL_VOTE_PREFIX, hideId: true },
    });
}

export type CastCasualBallotResult =
    | { kind: "ok" }
    | { kind: "changed" }
    | { kind: "unchanged" }
    | { kind: "change_locked" }
    | { kind: "not_found" }
    | { kind: "finder" };

/**
 * One ballot on a regular forward: the finder can't vote on their own find, everyone else (admins
 * included) casts a plain ballot and may switch once. A first ballot or a switch re-edits the card with the live count.
 */
export async function castCasualBallot(
    client: BotClient,
    voteId: string,
    discordUserId: string,
    choice: VoteChoice,
    deps: CasualVoteDeps = defaultCasualVoteDeps(),
): Promise<CastCasualBallotResult> {
    const vote = await deps.getCasualVote(voteId);
    if (!vote) return { kind: "not_found" };
    if (vote.finder_discord_id === discordUserId) return { kind: "finder" };

    const written = await deps.insertCasualBallot(voteId, discordUserId, choice);
    if (written === "closed") return { kind: "not_found" };
    if (written === "unchanged" || written === "change_locked") return { kind: written };

    await refreshCasualMessage(client, vote, await deps.getCasualTally(voteId));
    return { kind: written === "changed" ? "changed" : "ok" };
}

async function refreshCasualMessage(client: BotClient, vote: CasualVoteRow, tally: { real: number; fake: number }): Promise<void> {
    const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(vote.message_id).catch(() => null);
    if (!message) return;
    await message
        .edit({
            components: [casualVoteCard(vote, tally, message.createdAt)],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: NO_PINGS,
        })
        .catch(() => {});
}
