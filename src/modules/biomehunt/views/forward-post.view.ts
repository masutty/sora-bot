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
 * What sets a forward apart from a plain live one - shown as a profile-style badges block, and any
 * badge adds a "?" button whose ephemeral reply briefly explains them (see `forward-info.component.ts`).
 */
export interface ForwardBadges {
    delayed?: boolean;
    /** A `/bh-owner simulate-biome` dry run - also gets a "simulated" banner on top. */
    simulated?: boolean;
}

const DELAYED_EMOJI = "⏳";
const SIMULATED_EMOJI = "🧪";

export const FORWARD_INFO_PREFIX = "biomehunt:forward-info";

/** `biomehunt:forward-info:<0|1 delayed>:<0|1 simulated>` - the "?" reply needs nothing else, no DB lookup. */
export function forwardInfoCustomId(badges: ForwardBadges): string {
    return `${FORWARD_INFO_PREFIX}:${badges.delayed ? "1" : "0"}:${badges.simulated ? "1" : "0"}`;
}

/** Inverse of `forwardInfoCustomId` (the parts after the prefix) - `null` if malformed. */
export function parseForwardInfoParts(parts: string[]): ForwardBadges | null {
    const [delayed, simulated] = parts;
    const isFlag = (v: string | undefined) => v === "0" || v === "1";
    if (!isFlag(delayed) || !isFlag(simulated)) return null;
    return { delayed: delayed === "1", simulated: simulated === "1" };
}

/**
 * The "?" button's ephemeral explanation - one short line per badge. Deliberately vague: it must
 * not reveal how long the delay is or that other channels were pinged first.
 */
export function buildForwardInfoText(badges: ForwardBadges): string {
    const lines = ["**Badges**"];
    if (badges.delayed) lines.push(`${DELAYED_EMOJI} **Delayed** - this forward was sent with a delay.`);
    if (badges.simulated) lines.push(`${SIMULATED_EMOJI} **Simulated** - a test forward, not a real find.`);
    return lines.join("\n");
}

function hasBadges(badges: ForwardBadges | undefined): badges is ForwardBadges {
    return Boolean(badges?.delayed || badges?.simulated);
}

/** Same shape as the profile's badges block (`**Badges**` + the emojis) - the "?" button explains them. */
function badgesBlock(badges: ForwardBadges): string {
    return `**Badges**\n${[badges.delayed ? DELAYED_EMOJI : null, badges.simulated ? SIMULATED_EMOJI : null].filter(Boolean).join(" ")}`;
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
    if (params.roleId) headingLines.push(`<@&${params.roleId}>`);
    if (params.findCount) headingLines.push(`This is the #${params.findCount} ${spoofBiomeName(params.biome)} they found!`);
    if (params.jumpLink) headingLines.push(`- Sent from: ${params.jumpLink}`);

    const container = new ContainerBuilder().setAccentColor(getBiomeColor(params.biome));
    if (badges?.simulated) {
        container.addTextDisplayComponents((td) => td.setContent(`### ${SIMULATED_EMOJI} SIMULATED FORWARD - TESTING ONLY`));
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

    if (hasBadges(badges)) {
        container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
        container.addTextDisplayComponents((td) => td.setContent(badgesBlock(badges)));
    }

    if (params.vote) {
        container.spliceComponents(container.components.length, 0, ...buildVoteBlockComponents(params.vote));
    }

    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink, badges));

    return container;
}
