import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, SeparatorBuilder,
    TextDisplayBuilder, ThumbnailBuilder,
} from "discord.js";
import { formatBiomeName, getBiomeColor, getBiomeIconUrl, type VoteCheckDecidedBy, type VoteCheckStatus } from "../types";

export interface VoteRenderInfo {
    status: VoteCheckStatus;
    decidedBy: VoteCheckDecidedBy;
    decidedByUserId: string | null;
}

export interface ForwardContainerParams {
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    vote?: VoteRenderInfo;
}

function buildVoteButtonsRow(status: VoteCheckStatus): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("bh-vote-confirm").setEmoji("✅").setStyle(status === "confirmed" ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("bh-vote-deny").setEmoji("❌").setStyle(status === "denied" ? ButtonStyle.Danger : ButtonStyle.Secondary),
    );
}

function buildLinkButtonsRow(jumpLink: string, serverLink: string | null): ActionRowBuilder<ButtonBuilder> {
    const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(jumpLink).setLabel("Jump to Message")];
    if (serverLink) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(serverLink).setLabel("Join Private Server").setEmoji("🔗"));
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** No line while pending (just the buttons) - only shown once an admin has actually decided. */
function voteStatusLine(vote: VoteRenderInfo): string | null {
    if (vote.status === "pending") return "## Is this biome correct?";

    const status = vote.status === "confirmed" ? "Marked as real" : "Marked as fake";
    const emoji = vote.status === "confirmed" ? "✅" : "❌";
    return `${emoji} ${status} by <@${vote.decidedByUserId}>.`;
}

/**
 * Builds the biome forward Container from scratch - used both for the initial send and for
 * every later edit (admin decision), since Components V2 messages must be edited by replacing
 * the whole component tree rather than patching one piece of it. `jumpLink` must always be the
 * ORIGINAL webhook message that triggered the forward - never recompute it from the forward
 * message's own identity, or edits will make it point to itself.
 */
export function buildForwardContainer(params: ForwardContainerParams): ContainerBuilder {
    const headingLines = [`# [${formatBiomeName(params.biome)}](${params.serverLink})`];
    if (params.roleId) headingLines.push(`<@&${params.roleId}>`);
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
        container.addSeparatorComponents(new SeparatorBuilder());
        const statusLine = voteStatusLine(params.vote);
        if (statusLine) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine));
        if (!params?.vote?.decidedBy)  {
            container.addActionRowComponents(buildVoteButtonsRow(params.vote.status));
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# The buttons above are meant for admins only.")); // intentional!
        }
    }
    
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink));

    return container;
}
