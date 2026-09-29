import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
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
    badges?: ForwardBadges;
}

/**
 * What sets a forward apart from a plain live one - each shows as a badge under the biome name, and
 * any badge adds a "?" button whose ephemeral reply explains them (see `forward-info.component.ts`).
 */
export interface ForwardBadges {
    /** A delayed forward - when the biome was actually found, and how long the send waited. */
    delayed?: { foundAt: Date; delayS: number };
    /** A `/bh-owner simulate-biome` dry run - also gets a big "simulated" banner on top. */
    simulated?: boolean;
}

export const FORWARD_INFO_PREFIX = "biomehunt:forward-info";

/** `biomehunt:forward-info:<delayS|->:<foundAt epoch|->:<1|0>` - everything the "?" reply needs lives in the id, no DB lookup. */
export function forwardInfoCustomId(badges: ForwardBadges): string {
    const delayed = badges.delayed;
    const delayS = delayed ? String(delayed.delayS) : "-";
    const foundAt = delayed ? String(Math.floor(delayed.foundAt.getTime() / 1000)) : "-";
    return `${FORWARD_INFO_PREFIX}:${delayS}:${foundAt}:${badges.simulated ? "1" : "0"}`;
}

/** Inverse of `forwardInfoCustomId` (the parts after the prefix) - `null` if malformed. */
export function parseForwardInfoParts(parts: string[]): ForwardBadges | null {
    const [delayRaw, foundAtRaw, simulatedRaw] = parts;
    if (simulatedRaw !== "1" && simulatedRaw !== "0") return null;
    const badges: ForwardBadges = { simulated: simulatedRaw === "1" };
    if (delayRaw !== "-") {
        const delayS = Number(delayRaw);
        const foundAtS = Number(foundAtRaw);
        if (!Number.isInteger(delayS) || !Number.isInteger(foundAtS)) return null;
        badges.delayed = { delayS, foundAt: new Date(foundAtS * 1000) };
    }
    return badges;
}

/** The "?" button's ephemeral explanation - one paragraph per badge. */
export function buildForwardInfoText(badges: ForwardBadges): string {
    const lines = ["**About this forward**"];
    if (badges.delayed) {
        const epoch = Math.floor(badges.delayed.foundAt.getTime() / 1000);
        lines.push(
            `\`⏳ DELAYED\` - sent ${badges.delayed.delayS}s after the biome was found (found <t:${epoch}:T>, <t:${epoch}:R>). Another channel may have been alerted the moment it was found.`,
        );
    }
    if (badges.simulated) {
        lines.push(
            "`🧪 SIMULATED` - a test sent with `/bh-owner simulate-biome` (dry run). It's not a real find: nobody was pinged, no vote was opened, and nothing counts toward anyone's stats.",
        );
    }
    if (lines.length === 1) lines.push("A regular forward, sent the moment the biome was found.");
    return lines.join("\n\n");
}

function hasBadges(badges: ForwardBadges | undefined): badges is ForwardBadges {
    return Boolean(badges?.delayed || badges?.simulated);
}

function badgeLine(badges: ForwardBadges): string {
    return [badges.delayed ? "`⏳ DELAYED`" : null, badges.simulated ? "`🧪 SIMULATED`" : null].filter(Boolean).join(" ");
}

function buildVoteButtonsRow(voteId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`biomehunt:vote:${voteId}:real`).setLabel("Real").setEmoji("✅").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`biomehunt:vote:${voteId}:fake`).setLabel("Fake").setEmoji("❌").setStyle(ButtonStyle.Secondary),
    );
}

function buildLinkButtonsRow(
    jumpLink: string,
    serverLink: string | null,
    badges: ForwardBadges | undefined,
): ActionRowBuilder<ButtonBuilder> {
    const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(jumpLink).setLabel("Jump to Message")];
    if (serverLink)
        buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(serverLink).setLabel("Join Private Server").setEmoji("🔗"));
    if (hasBadges(badges))
        buttons.push(new ButtonBuilder().setCustomId(forwardInfoCustomId(badges)).setLabel("?").setStyle(ButtonStyle.Secondary));
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Main line of the vote block - one per `VoteStatus`. English, per the vote model's "Final states". */
function voteStatusLine(vote: VoteRenderInfo): string {
    const real = vote.tally?.real ?? 0;
    const fake = vote.tally?.fake ?? 0;

    switch (vote.status) {
        case VoteStatus.OPEN:
            return "**Is this biome real?**\n-# Administrators can immediately decide this vote";
        case VoteStatus.NO_VOTES:
            return "*Vote expired with no votes*";
        case VoteStatus.TIE:
            return `Tied vote (${real}/${fake})`;
        case VoteStatus.COMMUNITY_REAL:
            return `✅ Ruled real via voting (${real}/${fake})`;
        case VoteStatus.COMMUNITY_FAKE:
            return `❌ Ruled fake via voting (${real}/${fake})`;
        case VoteStatus.ADMIN_CONFIRMED:
            return `✅ Ruled real by <@${vote.decidedByUserId}>`;
        case VoteStatus.ADMIN_DENIED:
            return `❌ Ruled fake by <@${vote.decidedByUserId}>`;
        default: {
            const exhaustive: never = vote.status;
            throw new Error(`Unhandled vote status: ${exhaustive}`);
        }
    }
}

/** Top line of a voted forward (where the profile shows the level): the id, plus "• N votes • closes <t:R>" while the vote is open. */
function voteIdLine(vote: VoteRenderInfo): string {
    const id = `-# Vote ID: \`${vote.voteId}\``;
    if (vote.status !== VoteStatus.OPEN) return id;
    const epoch = Math.floor(vote.closesAt.getTime() / 1000);
    return `${id} • ${vote.voteCount} vote${vote.voteCount === 1 ? "" : "s"} • closes <t:${epoch}:R>`;
}

/**
 * The vote block's own components (a Large separator, the status line, and - only while open -
 * the Real/Fake buttons). The vote id line sits at the TOP of the container instead (see
 * `buildForwardContainer`), which every render - initial send and later edits - goes through.
 */
function buildVoteBlockComponents(vote: VoteRenderInfo): Array<SeparatorBuilder | TextDisplayBuilder | ActionRowBuilder<ButtonBuilder>> {
    const parts: Array<SeparatorBuilder | TextDisplayBuilder | ActionRowBuilder<ButtonBuilder>> = [
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        new TextDisplayBuilder().setContent(voteStatusLine(vote)),
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
    const { badges } = params;
    const headingLines = [`# [${spoofBiomeName(params.biome)}](${params.serverLink})`];
    if (hasBadges(badges)) headingLines.push(badgeLine(badges));
    if (params.roleId) headingLines.push(`<@&${params.roleId}>`);
    if (params.findCount) headingLines.push(`This is the #${params.findCount} ${spoofBiomeName(params.biome)} they found!`);
    if (params.jumpLink) headingLines.push(`- Sent from: ${params.jumpLink}`);

    const container = new ContainerBuilder().setAccentColor(getBiomeColor(params.biome));
    if (badges?.simulated) {
        container.addTextDisplayComponents((td) => td.setContent("# THIS IS A SIMULATED FORWARD FOR TESTING PURPOSES"));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }

    const { vote } = params;
    if (vote) {
        container.addTextDisplayComponents((td) => td.setContent(voteIdLine(vote)));
        container.addSeparatorComponents((sep) => sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small));
    }

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
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink, badges));

    return container;
}
