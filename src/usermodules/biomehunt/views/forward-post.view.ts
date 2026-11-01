import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    type MessageMentionOptions,
    SectionBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import type { ViewPayload } from "@/define";
import { ordinal } from "@/utils/format";
import { formatBiomeName, getBiomeColor, getBiomeIconUrl, getBiomeMeta, spoofBiomeName } from "../constants/biomes.constants";
import { VOTE_EMOJIS } from "../constants/vote-emojis.constants";
import { VoteStatus } from "../types";
import { localVoteVerdict, voteResultLine } from "./vote-outcome";

/** Customid prefix of the Real/Fake buttons on a forward - routed by `biome-vote.component.ts`. */
export const BIOME_VOTE_PREFIX = "biomehunt:vote";

export interface VoteRenderInfo {
    /** The vote's id - the middle segment of its buttons' customIds, and what "?" shows (unless `hideId`). */
    voteId: string;
    status: VoteStatus;
    /** Ballots so far - live while the vote is open, final once it is decided. */
    tally: { real: number; fake: number };
    /** Discord id of the deciding admin - only set for admin_confirmed/admin_denied. */
    decidedByUserId?: string;
    /** Prefix of the Real/Fake customIds. Default: the rare-biome vote. */
    prefix?: string;
    /** Keep the id out of "?" - for votes `/admin check-vote` cannot resolve. */
    hideId?: boolean;
}

export interface ForwardContainerParams {
    biome: string;
    roleId: string | null;
    serverLink: string | null;
    jumpLink: string;
    /** The finder's Discord id - named in the card, never pinged (senders must only allow the role mention). Omit to not name them. */
    finderDiscordId?: string | null;
    /** How many times (including this one) the finder has found this biome - "3rd personal find". */
    findCount?: number | null;
    /** How many times (including this one) this biome was found in the server - "41st in this server". */
    serverFindCount?: number | null;
    /** When this biome was last found in the server - kept on the stored vote, no longer shown on the card. */
    lastSeenInServerAt?: Date | null;
    /** When this forward was posted - a relative `<t:R>` beside the ping, so busy channels don't need Discord's own timestamp. */
    sentAt?: Date;
    vote?: VoteRenderInfo;
    badges?: ForwardBadges;
    /** The biome's optional in-game style line (`getBiomeMeta(biome)?.flavorText`), shown small on its own line right under the title. */
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

/** What sets a forward apart from a plain live one - shown as a quote line of chips, explained by the "?" button. */
export interface ForwardBadges {
    delayed?: boolean;
    /** A `/owner simulate-biome` dry run - also gets a "simulated" banner on top. */
    simulated?: boolean;
    /** A Network Mirror - relayed from another server in the Network. */
    network?: boolean;
    /** A Network Mirror of this server's own find - sent without a ping, since the local post already pinged. */
    home?: boolean;
}

export const FORWARD_INFO_PREFIX = "biomehunt:forward-info";

/** The flags in customId order - delayed and simulated always written, the later ones only up to the last set one. */
const FLAG_ORDER = ["delayed", "simulated", "network", "home"] as const;

const VOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * `biomehunt:forward-info:<delayed>:<simulated>[:<network>[:<home>]]` (each 0|1), plus - when the
 * card has a vote - all four flags and the vote id as a fifth part. The reply needs nothing else,
 * no DB lookup. Ids without a vote id keep their exact old shape, so buttons on posted messages still work.
 */
export function forwardInfoCustomId(badges: ForwardBadges, voteId?: string | null): string {
    const flags = FLAG_ORDER.map((key) => (badges[key] ? "1" : "0"));
    if (voteId) return `${FORWARD_INFO_PREFIX}:${[...flags, voteId].join(":")}`;
    while (flags.length > 2 && flags[flags.length - 1] === "0") flags.pop();
    return `${FORWARD_INFO_PREFIX}:${flags.join(":")}`;
}

/** Inverse of `forwardInfoCustomId` (the parts after the prefix) - `null` if malformed. */
export function parseForwardInfoParts(parts: string[]): { badges: ForwardBadges; voteId: string | null } | null {
    const hasId = parts.length === FLAG_ORDER.length + 1;
    const flagParts = hasId ? parts.slice(0, FLAG_ORDER.length) : parts;
    if (flagParts.length < 2 || flagParts.length > FLAG_ORDER.length || flagParts.some((p) => p !== "0" && p !== "1")) return null;
    const voteId = hasId ? parts[FLAG_ORDER.length] : null;
    if (voteId !== null && !VOTE_ID_PATTERN.test(voteId)) return null;

    const badges: ForwardBadges = { delayed: flagParts[0] === "1", simulated: flagParts[1] === "1" };
    if (flagParts[2] === "1") badges.network = true;
    if (flagParts[3] === "1") badges.home = true;
    return { badges, voteId };
}

/** Each forward type the "?" explains - deliberately vague: never how long the delay is, or that other channels were pinged first. */
const FORWARD_TYPE_INFO: Array<{ key: keyof ForwardBadges; emoji: string; name: string; description: string }> = [
    { key: "delayed", emoji: "⏳", name: "Delayed", description: "This forward was sent with a delay." },
    { key: "simulated", emoji: "🧪", name: "Simulated", description: "Not real, a bot developer is probably testing something!" },
    { key: "network", emoji: "🌐", name: "Network", description: "Shared through the Network." },
    { key: "home", emoji: "🏠", name: "Home", description: "Found in this server - no ping here, you already got the local post." },
];

/** The "?" button's ephemeral reply - a title, a divider, the vote id (if any), then each type as "- `emoji name`" with its explanation quoted under it. */
export function buildForwardInfoContainer(badges: ForwardBadges, voteId?: string | null): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## Extra information"));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const lines = FORWARD_TYPE_INFO.filter((t) => badges[t.key]).map((t) => `- \`${t.emoji} ${t.name}\`\n> ${t.description}`);
    if (voteId) lines.unshift(`- \`Vote ${voteId}\``);
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));

    return container;
}

function hasBadges(badges: ForwardBadges | undefined): badges is ForwardBadges {
    return Boolean(badges?.delayed || badges?.simulated || badges?.network || badges?.home);
}

/** The badges as one quote line of chips - "> `⏳ Delayed` `🌐 Network`" - or `null` when there are none. */
export function forwardBadgeLine(badges: ForwardBadges | undefined): string | null {
    if (!hasBadges(badges)) return null;
    const chips = FORWARD_TYPE_INFO.filter((t) => badges[t.key]).map((t) => `\`${t.emoji} ${t.name}\``);
    return `> ${chips.join(" ")}`;
}

/** The "?" button (routed by `forward-info.component.ts`), or `null` when the card has neither a badge nor a vote id to explain. */
export function forwardInfoButton(badges: ForwardBadges | undefined, voteId?: string | null): ButtonBuilder | null {
    if (!hasBadges(badges) && !voteId) return null;
    return new ButtonBuilder()
        .setCustomId(forwardInfoCustomId(badges ?? {}, voteId))
        .setLabel("?")
        .setStyle(ButtonStyle.Secondary);
}

export type VoteDecision = "real" | "fake" | "tie" | null;

/**
 * The Real/Fake button pair: always the plain count as the label (0 stays "0"), the outlined icon
 * until the vote is decided, the filled icon on the winning side (both on a tie). Disabled once the vote is closed.
 */
export function voteButtons(
    customIds: { real: string; fake: string },
    tally: { real: number; fake: number },
    decision: VoteDecision,
    disabled: boolean,
): [ButtonBuilder, ButtonBuilder] {
    const realFilled = decision === "real" || decision === "tie";
    const fakeFilled = decision === "fake" || decision === "tie";
    return [
        new ButtonBuilder()
            .setCustomId(customIds.real)
            .setLabel(String(tally.real))
            .setEmoji(realFilled ? VOTE_EMOJIS.realFilled : VOTE_EMOJIS.realOutline)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(customIds.fake)
            .setLabel(String(tally.fake))
            .setEmoji(fakeFilled ? VOTE_EMOJIS.fakeFilled : VOTE_EMOJIS.fakeOutline)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
    ];
}

/** A closed local vote's decision for the buttons: the winning side, a tie, or `null` while open / with no votes. */
function decisionOf(vote: VoteRenderInfo): VoteDecision {
    if (vote.status === VoteStatus.OPEN || vote.status === VoteStatus.NO_VOTES) return null;
    const verdict = localVoteVerdict(vote.status);
    return verdict === "real" || verdict === "fake" ? verdict : "tie";
}

function localVoteButtons(vote: VoteRenderInfo): [ButtonBuilder, ButtonBuilder] {
    const prefix = vote.prefix ?? BIOME_VOTE_PREFIX;
    return voteButtons(
        { real: `${prefix}:${vote.voteId}:real`, fake: `${prefix}:${vote.voteId}:fake` },
        vote.tally,
        decisionOf(vote),
        vote.status !== VoteStatus.OPEN,
    );
}

/** The "Join Private Server" button every card with a server link starts its row with. */
export function privateServerButton(url: string): ButtonBuilder {
    return new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Join Private Server").setEmoji("📬");
}

function epochOf(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}

/** "**3rd** personal find, **41st** in this server" - empty if neither count is known. */
function findCountsLine(findCount: number | null | undefined, serverFindCount: number | null | undefined): string {
    const parts: string[] = [];
    if (findCount) parts.push(`**${ordinal(findCount)}** personal find`);
    if (serverFindCount) parts.push(`**${ordinal(serverFindCount)}** in this server`);
    return parts.join(", ");
}

/**
 * The title block: the title (a big "🎉 X found!" for rare biomes, the plain name otherwise), the
 * flavor text right under it, then the role ping and the relative time. The ping sits inside the
 * card, beside the picture, so title and picture start at its top edge.
 */
function titleBlock(params: ForwardContainerParams): string {
    const name = spoofBiomeName(params.biome);
    const title = params.serverLink ? `[${name}](${params.serverLink})` : name;
    const isRare = getBiomeMeta(params.biome)?.category === "rare";

    const lines: string[] = [isRare ? `## 🎉 ${title} found!` : `# ${title}`];
    if (params.flavorText) lines.push(flavorLine(params.flavorText));
    const ping = [params.roleId ? `<@&${params.roleId}>` : null, params.sentAt ? `<t:${epochOf(params.sentAt)}:R>` : null].filter(Boolean);
    if (ping.length > 0) lines.push(ping.join(" · "));
    return lines.join("\n");
}

/** The bullet block under the title: who found it, the counts, how the vote ended, then the badges - empty when there is nothing to say. */
function detailLines(params: ForwardContainerParams): string[] {
    const lines: string[] = [];
    if (params.finderDiscordId) lines.push(`- Found by <@${params.finderDiscordId}>`);
    const counts = findCountsLine(params.findCount, params.serverFindCount);
    if (counts) lines.push(`- ${counts}`);
    if (params.vote && params.vote.status !== VoteStatus.OPEN) {
        const verdict = localVoteVerdict(params.vote.status);
        lines.push(`- ${voteResultLine({ verdict, tally: params.vote.tally, decidedBy: params.vote.decidedByUserId })}`);
    }
    const badgeLine = forwardBadgeLine(params.badges);
    if (badgeLine) lines.push(badgeLine);
    return lines;
}

function buildLinkRow(params: ForwardContainerParams): ActionRowBuilder<ButtonBuilder> {
    const buttons: ButtonBuilder[] = [];
    if (params.serverLink) buttons.push(privateServerButton(params.serverLink));
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(params.jumpLink).setLabel("Jump to Message"));
    if (params.vote) buttons.push(...localVoteButtons(params.vote));
    const info = forwardInfoButton(params.badges, params.vote?.hideId ? null : params.vote?.voteId);
    if (info) buttons.push(info);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/**
 * Builds the biome forward Container from scratch - used for the initial send and every edit.
 * `jumpLink` must always be the ORIGINAL webhook message that triggered the forward - never
 * recomputed from the forward message's own identity, or edits will make it point to itself.
 */
export function buildForwardContainer(params: ForwardContainerParams): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(params.biome));
    if (params.badges?.simulated) {
        container.addTextDisplayComponents((td) => td.setContent("### 🧪 SIMULATED FORWARD - TESTING ONLY"));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }

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

    const details = detailLines(params);
    if (details.length > 0) {
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) => td.setContent(details.join("\n")));
    }

    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addActionRowComponents(buildLinkRow(params));

    return container;
}

const TEST_COLOR = 0x4e5058;

/**
 * The test post `/admin forwarding` sends from "Send a test": the biome's card with a test line on
 * top, so it can't pass as a find. Sent with no mentions allowed - the role shows, nobody is pinged.
 */
export function buildTestForwardPost(biome: string, roleId: string | null, adminId: string): ViewPayload {
    const name = formatBiomeName(biome);
    const ping = roleId ? `Pings <@&${roleId}> on a real find.` : "Pings nobody on a real find.";
    const heading = `## ${name}\nThis is how a ${name} find will look here. ${ping}`;

    const container = new ContainerBuilder().setAccentColor(TEST_COLOR);
    container.addTextDisplayComponents((td) => td.setContent("**🧪 Test - not a real find**"));
    const iconUrl = getBiomeIconUrl(biome);
    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(heading));
    }
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(`-# Sent by <@${adminId}> from /admin forwarding. Nobody was pinged.`));

    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}
