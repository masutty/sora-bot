import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SectionBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { getBiomeColor, getBiomeIconUrl, spoofBiomeName } from "../constants/biomes.constants";
import type { NetworkPostRow, NetworkVoteStatus } from "../types";
import {
    type ForwardBadges,
    flavorLine,
    forwardBadgeLine,
    forwardInfoButton,
    privateServerButton,
    type VoteDecision,
    voteButtons,
} from "./forward-post.view";
import { type VoteTally, voteResultLine } from "./vote-outcome";

/** Customid prefix of the Real/Fake buttons on a Mirror - routed by `network-vote.component.ts`. */
export const NETWORK_VOTE_PREFIX = "biomehunt:net-vote";

/** The longest origin name a Mirror shows - a long server name must never widen or lengthen the card. */
const ORIGIN_NAME_MAX = 18;

/** The post fields a Mirror is built from - its render snapshot, never re-derived. */
export type MirrorPost = Pick<NetworkPostRow, "id" | "biome" | "origin_name" | "origin_icon_url" | "invite_url" | "server_link">;

/** Every ballot cast on a Network vote - one per person, from any Member Server. */
export type Scoreboard = VoteTally;

export interface MirrorVoteInfo {
    status: NetworkVoteStatus;
    /** The ballots so far - live while open, final once closed. Default: none yet. */
    scoreboard?: Scoreboard;
    /** The bot owner who decided it with a click - unset when the ballots decided it. */
    decidedBy?: string | null;
}

export interface MirrorParams {
    post: MirrorPost;
    /** This Member Server's ping role for the biome - shown (and allowed to ping) only on the first send. */
    roleId: string | null;
    vote?: MirrorVoteInfo;
    /** A test (`simulate-biome network` / `network_relays`) - marked, no vote. */
    simulated?: boolean;
    /** The origin's own channel - Home badge, and never a ping (the local post already pinged). */
    home?: boolean;
    /** The biome's optional flavor text (`getBiomeMeta(biome)?.flavorText`), on its own small line under the title. */
    flavorText?: string | null;
}

/** The private scoreboard text used in alerts about a Fake verdict. */
export function formatScoreboard(s: Scoreboard): string {
    return `✅ Real **${s.real}** · ❌ Fake **${s.fake}**`;
}

/**
 * A server's name for any message that mentions it: a link to its invite when it has one, bold text
 * otherwise. Brackets and parentheses are dropped from the name so it can never break out of the
 * link. `maxLength` cuts a long name with an ellipsis.
 */
export function serverNameLink(name: string, inviteUrl: string | null, maxLength?: number): string {
    let safe =
        name
            .replace(/[[\]()]/g, "")
            .replace(/\s+/g, " ")
            .trim() || "server";
    if (maxLength && safe.length > maxLength) safe = `${safe.slice(0, maxLength - 1).trimEnd()}…`;
    return inviteUrl ? `[${safe}](${inviteUrl})` : `**${safe}**`;
}

/** A closed Network vote's decision for the buttons: the winning side, a tie, or `null` while open / with no ballots. */
function decisionOf(vote: MirrorVoteInfo, board: Scoreboard): VoteDecision {
    if (vote.status === "open") return null;
    if (vote.status === "real" || vote.status === "fake") return vote.status;
    return board.real + board.fake === 0 ? null : "tie";
}

function voteButtonPair(postId: string, vote: MirrorVoteInfo): [ButtonBuilder, ButtonBuilder] {
    const board = vote.scoreboard ?? { real: 0, fake: 0 };
    return voteButtons(
        { real: `${NETWORK_VOTE_PREFIX}:${postId}:real`, fake: `${NETWORK_VOTE_PREFIX}:${postId}:fake` },
        board,
        decisionOf(vote, board),
        vote.status !== "open",
    );
}

/** "Join Private Server", then a fixed "Join Discord" when the origin has an invite - the origin's name is never a label. */
function linkButtons(post: MirrorPost): ButtonBuilder[] {
    const buttons = [privateServerButton(post.server_link)];
    if (post.invite_url) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(post.invite_url).setLabel("Join Discord"));
    return buttons;
}

/**
 * A Network Post as it appears in one Member Server - the same shape as the local forward card: the
 * title and picture at the top, the ping under the flavor text, a bullet saying where it came from
 * (the origin's name, cut short, linked to its invite), a quote line of badges (🌐 Network, 🏠 in the
 * origin's own channel, 🧪 for a test), then the links, the live Real/Fake votes and the "?" in one
 * row. Built only from parsed fields - no free text from the macro reaches another server.
 */
export function buildMirrorContainer(p: MirrorParams): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(p.post.biome));
    if (p.simulated) {
        container.addTextDisplayComponents((td) => td.setContent("### 🧪 SIMULATED NETWORK POST - TESTING ONLY"));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }

    const name = spoofBiomeName(p.post.biome);
    const heading = [`## 🎉 [${name}](${p.post.server_link}) found!`];
    if (p.flavorText) heading.push(flavorLine(p.flavorText));
    if (p.roleId && !p.home) heading.push(`<@&${p.roleId}>`);
    const iconUrl = getBiomeIconUrl(p.post.biome);
    const display = new TextDisplayBuilder().setContent(heading.join("\n"));
    container.addSectionComponents(
        iconUrl
            ? new SectionBuilder()
                  .addTextDisplayComponents(display)
                  .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } }))
            : new SectionBuilder().addTextDisplayComponents(display),
    );

    const badges: ForwardBadges = { network: true, simulated: p.simulated, home: p.home };
    const vote = p.vote && !p.simulated ? p.vote : undefined;
    const details = [`- From ${serverNameLink(p.post.origin_name, p.post.invite_url, ORIGIN_NAME_MAX)}`];
    if (vote && vote.status !== "open") {
        const tally = vote.scoreboard ?? { real: 0, fake: 0 };
        const verdict = vote.status !== "inconclusive" ? vote.status : tally.real + tally.fake === 0 ? "no_votes" : "tie";
        details.push(`- ${voteResultLine({ verdict, tally, decidedBy: vote.decidedBy, voters: "the Network" })}`);
    }
    const badgeLine = forwardBadgeLine(badges);
    if (badgeLine) details.push(badgeLine);
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(details.join("\n")));

    const buttons: ButtonBuilder[] = linkButtons(p.post);
    if (vote) buttons.push(...voteButtonPair(p.post.id, vote));
    const info = forwardInfoButton(badges, vote ? p.post.id : null);
    if (info) buttons.push(info);
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    return container;
}
