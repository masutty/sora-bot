import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, SeparatorBuilder,
    SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} from "discord.js";
import { getBiomeColor, getBiomeIconUrl, spoofBiomeName } from "../constants/biomes.constants";
import { VoteStatus } from "../types";

export interface VoteRenderInfo {
    /** Short random code, shown on the message so it can be referenced (e.g. `/bh-admin review`). */
    voteId: string;
    status: VoteStatus;
    closesAt: Date;
    /** Ballots cast so far - shown while open ("Vote ID • N votes • closes <t:R>"). The Real/Fake split stays hidden until the vote closes. */
    voteCount: number;
    /** Real/Fake split - only rendered once `status` is no longer `open`. */
    tally?: { real: number; fake: number };
    /** Discord id of the deciding admin - only set for admin_confirmed/admin_denied. */
    decidedByUserId?: string;
}

export interface ForwardContainerParams {
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    /** How many times (including this one) the finder has found this specific biome - shown as "this is the #N <biome> they found!". Omit to not show the line. */
    findCount?: number;
    vote?: VoteRenderInfo;
}

function buildVoteButtonsRow(voteId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`biomehunt:vote:${voteId}:real`).setLabel("Real").setEmoji("✅").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`biomehunt:vote:${voteId}:fake`).setLabel("Fake").setEmoji("❌").setStyle(ButtonStyle.Secondary),
    );
}

function buildLinkButtonsRow(jumpLink: string, serverLink: string | null): ActionRowBuilder<ButtonBuilder> {
    const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(jumpLink).setLabel("Jump to Message")];
    if (serverLink) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(serverLink).setLabel("Join Private Server").setEmoji("🔗"));
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Main line of the vote block - one per `VoteStatus`. English, per the vote model's "Final states". */
function voteStatusLine(vote: VoteRenderInfo): string {
    const real = vote.tally?.real ?? 0;
    const fake = vote.tally?.fake ?? 0;

    switch (vote.status) {
        case VoteStatus.OPEN:
            return "## Is this biome real?";
        case VoteStatus.NO_VOTES:
            return "Vote expired with no votes - nothing changed.";
        case VoteStatus.TIE:
            return `Tied vote (${real}×${fake}) - nothing changed.`;
        case VoteStatus.COMMUNITY_REAL:
            return `✅ Confirmed by community vote (${real}×${fake}).`;
        case VoteStatus.COMMUNITY_FAKE:
            return `❌ Rejected by community vote (${real}×${fake}) - nothing changed.`;
        case VoteStatus.ADMIN_CONFIRMED:
            return `✅ Confirmed by <@${vote.decidedByUserId}> (admin).`;
        case VoteStatus.ADMIN_DENIED:
            return `❌ Denied by <@${vote.decidedByUserId}> (admin).`;
        default: {
            const exhaustive: never = vote.status;
            throw new Error(`Unhandled vote status: ${exhaustive}`);
        }
    }
}

/** Footer of the vote block: the id, plus "• N votes • closes <t:R>" while the vote is open. */
function voteIdLine(vote: VoteRenderInfo): string {
    const id = `-# Vote ID: \`${vote.voteId}\``;
    if (vote.status !== VoteStatus.OPEN) return id;
    const epoch = Math.floor(vote.closesAt.getTime() / 1000);
    return `${id} • ${vote.voteCount} vote${vote.voteCount === 1 ? "" : "s"} • closes <t:${epoch}:R>`;
}

/**
 * The vote block's own components (a Large separator, the status line, the vote id line, and -
 * only while open - the Real/Fake buttons). Shared by `buildForwardContainer` (the
 * initial send) and `updateVoteContainer` (every later edit), so both always produce the exact
 * same shape.
 */
function buildVoteBlockComponents(vote: VoteRenderInfo): Array<SeparatorBuilder | TextDisplayBuilder | ActionRowBuilder<ButtonBuilder>> {
    const parts: Array<SeparatorBuilder | TextDisplayBuilder | ActionRowBuilder<ButtonBuilder>> = [
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        new TextDisplayBuilder().setContent(voteStatusLine(vote)),
        new TextDisplayBuilder().setContent(voteIdLine(vote)),
    ];

    if (vote.status === VoteStatus.OPEN) parts.push(buildVoteButtonsRow(vote.voteId));

    return parts;
}

/**
 * Builds the biome forward Container from scratch - used for the initial send. `jumpLink` must
 * always be the ORIGINAL webhook message that triggered the forward - never recomputed from the
 * forward message's own identity, or edits will make it point to itself.
 */
export function buildForwardContainer(params: ForwardContainerParams): ContainerBuilder {
    const headingLines = [`# [${spoofBiomeName(params.biome)}](${params.serverLink})`];
    if (params.roleId) headingLines.push(`<@&${params.roleId}>`);
    if (params.findCount) headingLines.push(`This is the #${params.findCount} ${spoofBiomeName(params.biome)} they found!`);
    if (params.jumpLink) headingLines.push(`- Sent from: ${params.jumpLink}`);

    const container = new ContainerBuilder().setAccentColor(getBiomeColor(params.biome));

    const iconUrl = getBiomeIconUrl(params.biome);
    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(headingLines.join("\n")))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headingLines.join("\n")));
    }

    if (params.vote) {
        container.spliceComponents(container.components.length, 0, ...buildVoteBlockComponents(params.vote));
    }

    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink));

    return container;
}
