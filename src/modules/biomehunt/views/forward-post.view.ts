import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    type MessageMentionOptions,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { BIOME_META, getBiomeColor, getBiomeIconUrl, spoofBiomeName } from "../constants/biomes.constants";
import { VoteStatus } from "../types";

export interface VoteRenderInfo {
    /** Short random code, shown on the message so it can be referenced (e.g. `/bh-admin review`). */
    voteId: string;
    status: VoteStatus;
    closesAt: Date;
    /** Ballots cast so far - shown while open ("Vote ID • N votes"). The Real/Fake split stays hidden until the vote closes. */
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
    /** The finder's Discord id - named in the card, never pinged (senders must only allow the role mention). Omit to not name them. */
    finderDiscordId?: string | null;
    /** How many times (including this one) the finder has found this biome - "Personal find #N". */
    findCount?: number | null;
    /** How many times (including this one) this biome was found in the server - "Server find #N". */
    serverFindCount?: number | null;
    /** When this biome was last found in the server before this find - "Last one <t:R>". `null` = never. */
    lastSeenInServerAt?: Date | null;
    vote?: VoteRenderInfo;
    badges?: ForwardBadges;
}

/** The finder/count inputs of a forward card, computed once per find and reused by the live forward, its vote, and the delayed forward. */
export type ForwardFindStats = Pick<ForwardContainerParams, "finderDiscordId" | "findCount" | "serverFindCount" | "lastSeenInServerAt">;

/**
 * A forward's `allowedMentions`: only its role may ping - the finder (and a deciding admin) are
 * named in the card but never pinged. A dry run pings nobody at all.
 */
export function forwardMentions(roleId: string | null, dryRun: boolean): MessageMentionOptions {
    return { parse: [], roles: roleId && !dryRun ? [roleId] : [] };
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

/** Each forward type the "?" explains - deliberately vague: never how long the delay is, or that other channels were pinged first. */
const FORWARD_TYPE_INFO: Array<{ key: keyof ForwardBadges; emoji: string; name: string; description: string }> = [
    { key: "delayed", emoji: DELAYED_EMOJI, name: "Delayed", description: "This forward was sent with a delay." },
    {
        key: "simulated",
        emoji: SIMULATED_EMOJI,
        name: "Simulated",
        description: "Not real, a bot developer is probably testing something!",
    },
];

/** The "?" button's ephemeral reply - a title, a divider, then each type as "- `emoji name`" with its explanation quoted under it. */
export function buildForwardInfoContainer(badges: ForwardBadges): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## Extra information"));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const types = FORWARD_TYPE_INFO.filter((t) => badges[t.key]).map((t) => `- \`${t.emoji} ${t.name}\`\n> ${t.description}`);
    container.addTextDisplayComponents((td) => td.setContent(types.join("\n")));

    return container;
}

function hasBadges(badges: ForwardBadges | undefined): badges is ForwardBadges {
    return Boolean(badges?.delayed || badges?.simulated);
}

/** Just the emojis, like the profile's badges - the "?" button explains them. */
function badgeEmojis(badges: ForwardBadges): string {
    return [badges.delayed ? DELAYED_EMOJI : null, badges.simulated ? SIMULATED_EMOJI : null].filter(Boolean).join(" ");
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

/** Main line of the vote block - one per `VoteStatus`. Community outcomes show the ballots as `✅ n` `❌ n` chips. */
function voteStatusLine(vote: VoteRenderInfo): string {
    const tally = ` \`✅ ${vote.tally?.real ?? 0}\` \`❌ ${vote.tally?.fake ?? 0}\``;

    switch (vote.status) {
        case VoteStatus.OPEN:
            return `**Is this biome real?** · ${vote.voteCount} vote${vote.voteCount === 1 ? "" : "s"} · voting closes <t:${epochOf(vote.closesAt)}:R>\n-# Administrators can immediately decide this vote`;
        case VoteStatus.NO_VOTES:
            return "*Vote expired with no votes*";
        case VoteStatus.TIE:
            return `⚖️ Tied vote${tally}`;
        case VoteStatus.COMMUNITY_REAL:
            return `✅ Marked as real by community voting${tally}`;
        case VoteStatus.COMMUNITY_FAKE:
            return `❌ Marked as fake by community voting${tally}`;
        case VoteStatus.ADMIN_CONFIRMED:
            return `✅ Marked as real by <@${vote.decidedByUserId}>`;
        case VoteStatus.ADMIN_DENIED:
            return `❌ Marked as fake by <@${vote.decidedByUserId}>`;
        default: {
            const exhaustive: never = vote.status;
            throw new Error(`Unhandled vote status: ${exhaustive}`);
        }
    }
}

function epochOf(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}

/** "Personal find #3 · Server find #41" - no pronouns about the finder; a count of 1 reads as "First". Empty if neither count is known. */
function findCountsLine(findCount: number | null | undefined, serverFindCount: number | null | undefined): string {
    const parts: string[] = [];
    if (findCount) parts.push(findCount === 1 ? "**First** personal find" : `Personal find **#${findCount}**`);
    if (serverFindCount) parts.push(serverFindCount === 1 ? "**First** in this server!" : `Server find **#${serverFindCount}**`);
    return parts.join(" · ");
}

/**
 * The card's heading, byline first: a small "Found by @finder" (the vote id rides after it, as
 * secondary info), then the title - a big "🎉 X found!" for rare biomes, the plain name otherwise -
 * then the counts and "Last one <t:R>". The finder never sits on the title or counts line: a long
 * display name there made every card a different width.
 */
function headingLines(params: ForwardContainerParams): string[] {
    const name = spoofBiomeName(params.biome);
    const title = params.serverLink ? `[${name}](${params.serverLink})` : name;
    const isRare = BIOME_META[params.biome]?.category === "rare";
    const counts = findCountsLine(params.findCount, params.serverFindCount);

    const byline = [
        params.finderDiscordId ? `Found by <@${params.finderDiscordId}>` : null,
        params.vote ? `Vote \`${params.vote.voteId}\`` : null,
    ].filter(Boolean);

    const lines: string[] = [];
    if (byline.length > 0) lines.push(`-# ${byline.join(" · ")}`);
    lines.push(isRare ? `## 🎉 ${title} found!` : `# ${title}`);
    if (counts) lines.push(counts);
    if (params.lastSeenInServerAt) lines.push(`-# Last one <t:${epochOf(params.lastSeenInServerAt)}:R>`);
    return lines;
}

/**
 * The vote block's own components (a Large separator, the status line, and - only while open -
 * the Real/Fake buttons). The vote id sits in the heading's byline instead (see `headingLines`),
 * which every render - initial send and later edits - goes through.
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

    const container = new ContainerBuilder().setAccentColor(getBiomeColor(params.biome));
    if (badges?.simulated) {
        container.addTextDisplayComponents((td) => td.setContent(`### ${SIMULATED_EMOJI} SIMULATED FORWARD - TESTING ONLY`));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }
    if (params.roleId) container.addTextDisplayComponents((td) => td.setContent(`<@&${params.roleId}>`));

    const heading = headingLines(params).join("\n");
    const iconUrl = getBiomeIconUrl(params.biome);
    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));
    }

    if (params.vote) {
        container.spliceComponents(container.components.length, 0, ...buildVoteBlockComponents(params.vote));
    }

    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    // Badges sit right on top of the buttons (no separator in between), so the "?" reads as theirs.
    if (hasBadges(badges)) container.addTextDisplayComponents((td) => td.setContent(badgeEmojis(badges)));
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink, badges));

    return container;
}
