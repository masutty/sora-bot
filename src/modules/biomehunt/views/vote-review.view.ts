import { ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineView, type HandlerContext, type ViewDefinition, type ViewPayload } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { getUserById } from "../repository/users.repository";
import { getBallotsForVote, getVoteById } from "../repository/votes.repository";
import { type AdminDecideResult, adminDecide } from "../services/biome-vote.service";
import type { BiomeVoteBallotRow, BiomeVoteRow } from "../types";
import { BiomeHuntError, VoteChoice, VoteStatus } from "../types";

/**
 * Everything the View needs that would otherwise be a DB/Discord call, injected so its tests never
 * touch either - `defaultVoteReviewDeps(client, voteId)` (called from `bh-admin.command.ts`) wires
 * the real ones, binding `client`/`voteId` into `adminDecide` (it needs both, and the View itself
 * only ever gets a plain `(adminDiscordId, choice)` call).
 */
export interface VoteReviewDeps {
    getVote(voteId: string): Promise<BiomeVoteRow | null>;
    getBallots(voteId: string): Promise<BiomeVoteBallotRow[]>;
    /** The finder's OWN Discord id (not `bh_users.id`) - `null` if their profile row is somehow gone. */
    getFinderDiscordId(userId: number): Promise<string | null>;
    /** Bound to `client`/`voteId` already - same CAS/reward semantics as the vote buttons
     * (`components/biome-vote.component.ts`), including the message edit it does itself. */
    adminDecide(adminDiscordId: string, choice: VoteChoice): Promise<AdminDecideResult>;
}

export function defaultVoteReviewDeps(client: BotClient, voteId: string): VoteReviewDeps {
    return {
        getVote: getVoteById,
        getBallots: getBallotsForVote,
        getFinderDiscordId: async (userId) => (await getUserById(userId))?.discord_user_id ?? null,
        adminDecide: (adminDiscordId, choice) => adminDecide(client, voteId, adminDiscordId, choice),
    };
}

export interface VoteReviewInput {
    voteId: string;
    guildId: string;
}

interface VoteReviewState {
    vote: BiomeVoteRow;
    ballots: BiomeVoteBallotRow[];
    finderDiscordId: string | null;
}

function tallyOf(ballots: BiomeVoteBallotRow[]): { real: number; fake: number } {
    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    return { real, fake: ballots.length - real };
}

/** One line per `VoteStatus` - same English wording as `forward-post.view.ts`'s `voteStatusLine`,
 * minus the emoji (this is an admin utility screen, not the public forward) and NEVER hiding the
 * tally while open - the whole point of `review` is showing an admin the real/fake split before
 * the vote has even closed, so they can override early if they want to. */
function voteStateLine(vote: BiomeVoteRow, tally: { real: number; fake: number }): string {
    const { real, fake } = tally;
    switch (vote.status) {
        case VoteStatus.OPEN: {
            const epoch = Math.floor(vote.closes_at.getTime() / 1000);
            return `Open - ${real}×${fake} so far, closes <t:${epoch}:R>.`;
        }
        case VoteStatus.NO_VOTES:
            return "Vote expired with no votes - nothing changed.";
        case VoteStatus.TIE:
            return `Tied vote (${real}×${fake}) - nothing changed.`;
        case VoteStatus.COMMUNITY_REAL:
            return `Confirmed by community vote (${real}×${fake}).`;
        case VoteStatus.COMMUNITY_FAKE:
            return `Rejected by community vote (${real}×${fake}) - nothing changed.`;
        case VoteStatus.ADMIN_CONFIRMED:
            return `Confirmed by <@${vote.decided_by}> (admin).`;
        case VoteStatus.ADMIN_DENIED:
            return `Denied by <@${vote.decided_by}> (admin).`;
        default: {
            const exhaustive: never = vote.status;
            throw new Error(`Unhandled vote status: ${exhaustive}`);
        }
    }
}

/** `<@id>, <@id>, ...` for one side of the ballot list, or `*none*` - `NO_PINGS` on the payload
 * keeps these from actually pinging anyone just for being listed. */
function votersLine(ballots: BiomeVoteBallotRow[], choice: VoteChoice): string {
    const mentions = ballots.filter((b) => b.choice === choice).map((b) => `<@${b.user_id}>`);
    return mentions.length > 0 ? mentions.join(", ") : "*none*";
}

function reviewContainer(state: VoteReviewState): ContainerBuilder {
    const { vote, ballots } = state;
    const tally = tallyOf(ballots);
    const openedEpoch = Math.floor(vote.created_at.getTime() / 1000);
    const finder = state.finderDiscordId ? `<@${state.finderDiscordId}>` : "*unknown*";

    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            `**Vote Review: \`${vote.id}\`**\n` +
                `${voteStateLine(vote, tally)}\n\n` +
                `Finder: ${finder}\n` +
                `Biome: ${formatBiomeName(vote.biome)}\n` +
                `When: <t:${openedEpoch}:R>`,
        ),
    );
    container.addSeparatorComponents((sep) => sep.setDivider(true));
    container.addTextDisplayComponents((td) => td.setContent(`Real voters: ${votersLine(ballots, VoteChoice.REAL)}`));
    container.addTextDisplayComponents((td) => td.setContent(`Fake voters: ${votersLine(ballots, VoteChoice.FAKE)}`));

    return container;
}

/** The admin's decisive click - shared by `confirm`/`deny`. Same CAS semantics as the vote
 * buttons: `already_decided` means someone else (a racing admin click, or the closing worker)
 * decided it in the very instant between this screen's last render and the click - never applied
 * twice. On success the state is updated in place so the screen redraws with the new outcome; the
 * forward message itself is already updated by `deps.adminDecide` (same as the component). */
async function decide(c: HandlerContext<VoteReviewState, void>, deps: VoteReviewDeps, choice: VoteChoice): Promise<void> {
    const result = await deps.adminDecide(c.user.id, choice);
    switch (result.kind) {
        case "not_found":
            await c.notify("This vote is no longer available.");
            return;
        case "already_decided":
            await c.notify("This vote was already decided.");
            return;
        case "ok":
            c.state.vote = { ...c.state.vote, status: result.status, decided_by: c.user.id };
            return;
    }
}

/**
 * `/bh-admin review <id>` - who voted Real/Fake, the vote's current state, and (since `bh-admin` is
 * already admin-only) Confirm/Deny buttons that call `adminDecide` the same way the forward
 * message's own buttons do, including AFTER the vote closed (overriding a community/no-votes/tie
 * outcome, or even flip-flopping an earlier admin decision - `adminDecide`'s CAS only guards
 * against a genuine race, never against reviewing something already decided).
 */
export function voteReviewView(deps: VoteReviewDeps): ViewDefinition<VoteReviewState, void, VoteReviewInput> {
    return defineView<VoteReviewState, void, VoteReviewInput>({
        name: "biomehunt.vote-review",
        initial: async (input) => {
            const vote = await deps.getVote(input.voteId);
            if (!vote || vote.guild_id !== input.guildId) throw new BiomeHuntError("No vote with that id.");
            const [ballots, finderDiscordId] = await Promise.all([
                deps.getBallots(input.voteId),
                deps.getFinderDiscordId(vote.finder_user_id),
            ]);
            return { vote, ballots, finderDiscordId };
        },
        render: (state, kit): ViewPayload => ({
            flags: MessageFlags.IsComponentsV2,
            components: [
                reviewContainer(state),
                kit.row(
                    kit.button("confirm", (b) => b.setLabel("Confirm").setEmoji("✅").setStyle(ButtonStyle.Success)),
                    kit.button("deny", (b) => b.setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger)),
                ),
            ],
            allowedMentions: NO_PINGS,
        }),
        on: {
            confirm: (c) => decide(c, deps, VoteChoice.REAL),
            deny: (c) => decide(c, deps, VoteChoice.FAKE),
        },
    });
}
