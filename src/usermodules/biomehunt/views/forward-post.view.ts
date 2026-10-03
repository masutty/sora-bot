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
    /** The biome's optional in-game style line (`BIOME_META[biome].flavorText`), shown small on its own line right under the title. */
    flavorText?: string | null;
}

/**
 * A biome's flavor text as a small `-#` line (local forward card and Network Mirror). Markdown in it
 * is escaped, so e.g. `Signal_Received ... Island_SOL` never turns into italics.
 */
export function flavorLine(text: string): string {
    return `-# ${text.replace(/([_*~`|\\])/g, "\\$1")}`;
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
    /** A Network Mirror - relayed from another server in the Network. */
    network?: boolean;
    /** A Network Mirror of this server's own find - sent without a ping, since the local post already pinged. */
    home?: boolean;
}

const DELAYED_EMOJI = "⏳";
const SIMULATED_EMOJI = "🧪";
const NETWORK_EMOJI = "🌐";
const HOME_EMOJI = "🏠";

export const FORWARD_INFO_PREFIX = "biomehunt:forward-info";

/** The flags in customId order - delayed and simulated always written, the later ones only up to the last set one. */
const FLAG_ORDER = ["delayed", "simulated", "network", "home"] as const;

/**
 * `biomehunt:forward-info:<delayed>:<simulated>[:<network>[:<home>]]` (each 0|1) - the "?" reply needs
 * nothing else, no DB lookup. Trailing unset flags after the first two are left off, so every older
 * id keeps its exact shape.
 */
export function forwardInfoCustomId(badges: ForwardBadges): string {
    const flags = FLAG_ORDER.map((key) => (badges[key] ? "1" : "0"));
    while (flags.length > 2 && flags[flags.length - 1] === "0") flags.pop();
    return `${FORWARD_INFO_PREFIX}:${flags.join(":")}`;
}

/** Inverse of `forwardInfoCustomId` (the parts after the prefix) - `null` if malformed. */
export function parseForwardInfoParts(parts: string[]): ForwardBadges | null {
    if (parts.length < 2 || parts.length > FLAG_ORDER.length || parts.some((p) => p !== "0" && p !== "1")) return null;
    const badges: ForwardBadges = { delayed: parts[0] === "1", simulated: parts[1] === "1" };
    if (parts[2] === "1") badges.network = true;
    if (parts[3] === "1") badges.home = true;
    return badges;
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
    {
        key: "network",
        emoji: NETWORK_EMOJI,
        name: "Network",
        description: "Shared through the Network.",
    },
    {
        key: "home",
        emoji: HOME_EMOJI,
        name: "Home",
        description: "Found in this server - no ping here, you already got the local post.",
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
    return Boolean(badges?.delayed || badges?.simulated || badges?.network || badges?.home);
}

/** Just the emojis, like the profile's badges - the "?" button explains them. */
export function forwardBadgeEmojis(badges: ForwardBadges): string {
    return [
        badges.delayed ? DELAYED_EMOJI : null,
        badges.simulated ? SIMULATED_EMOJI : null,
        badges.network ? NETWORK_EMOJI : null,
        badges.home ? HOME_EMOJI : null,
    ]
        .filter(Boolean)
        .join(" ");
}

/** The "?" button that explains `badges` (routed by `forward-info.component.ts`). */
export function forwardInfoButton(badges: ForwardBadges): ButtonBuilder {
    return new ButtonBuilder().setCustomId(forwardInfoCustomId(badges)).setLabel("?").setStyle(ButtonStyle.Secondary);
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
    if (hasBadges(badges)) buttons.push(forwardInfoButton(badges));
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
 * The card's title block, byline first: a small "Found by @finder" (the vote id rides after it, as
 * secondary info), then the title - a big "🎉 X found!" for rare biomes, the plain name otherwise -
 * with the flavor text right under it. The finder never sits on the title line: a long display
 * name there made every card a different width.
 */
function titleBlock(params: ForwardContainerParams): string {
    const name = spoofBiomeName(params.biome);
    const title = params.serverLink ? `[${name}](${params.serverLink})` : name;
    const isRare = BIOME_META[params.biome]?.category === "rare";

    const byline = [
        params.finderDiscordId ? `Found by <@${params.finderDiscordId}>` : null,
        params.vote ? `Vote \`${params.vote.voteId}\`` : null,
    ].filter(Boolean);

    const lines: string[] = [];
    if (byline.length > 0) lines.push(`-# ${byline.join(" · ")}`);
    lines.push(isRare ? `## 🎉 ${title} found!` : `# ${title}`);
    if (params.flavorText) lines.push(flavorLine(params.flavorText));
    return lines.join("\n");
}

/** The extra facts under the title block (counts, "Last one <t:R>") - empty when there are none. */
function detailLines(params: ForwardContainerParams): string[] {
    const counts = findCountsLine(params.findCount, params.serverFindCount);
    const lines: string[] = [];
    if (counts) lines.push(counts);
    if (params.lastSeenInServerAt) lines.push(`-# Last one <t:${epochOf(params.lastSeenInServerAt)}:R>`);
    return lines;
}

/**
 * The vote block's own components (a Large separator, the status line, and - only while open -
 * the Real/Fake buttons). The vote id sits in the heading's byline instead (see `titleBlock`),
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

    const heading = titleBlock(params);
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

    // A divider keeps the title block (and its flavor text) apart from the extra facts.
    const details = detailLines(params);
    if (details.length > 0) {
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) => td.setContent(details.join("\n")));
    }

    if (params.vote) {
        container.spliceComponents(container.components.length, 0, ...buildVoteBlockComponents(params.vote));
    }

    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    // Badges sit right on top of the buttons (no separator in between), so the "?" reads as theirs.
    if (hasBadges(badges)) container.addTextDisplayComponents((td) => td.setContent(forwardBadgeEmojis(badges)));
    container.addActionRowComponents(buildLinkButtonsRow(params.jumpLink, params.serverLink, badges));

    return container;
}
