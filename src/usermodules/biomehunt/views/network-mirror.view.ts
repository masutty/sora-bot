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
import { type ForwardBadges, flavorLine, forwardBadgeEmojis, forwardInfoButton } from "./forward-post.view";
import { type VoteTally, voteOutcomeLine } from "./vote-outcome";

/** Customid prefix of the Real/Fake buttons on a Mirror - routed by `network-vote.component.ts`. */
export const NETWORK_VOTE_PREFIX = "biomehunt:net-vote";

/** The post fields a Mirror is built from - its render snapshot, never re-derived. */
export type MirrorPost = Pick<NetworkPostRow, "id" | "biome" | "origin_name" | "origin_icon_url" | "invite_url" | "server_link">;

/** Every ballot cast on a Network vote - one per person, from any Member Server. */
export type Scoreboard = VoteTally;

export interface MirrorVoteInfo {
    status: NetworkVoteStatus;
    /** Shown once the vote is closed. */
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

/** The private scoreboard a voter gets after clicking (the Mirror itself is only edited at close). */
export function formatScoreboard(s: Scoreboard): string {
    return `✅ Real **${s.real}** · ❌ Fake **${s.fake}**`;
}

/**
 * A server's name for any message that mentions it: a link to its invite when it has one, bold text
 * otherwise. Brackets and parentheses are dropped from the name so it can never break out of the link.
 */
export function serverNameLink(name: string, inviteUrl: string | null): string {
    if (!inviteUrl) return `**${name}**`;
    const safe =
        name
            .replace(/[[\]()]/g, "")
            .replace(/\s+/g, " ")
            .trim() || "server";
    return `[${safe}](${inviteUrl})`;
}

/** The vote block's text: the question while open, then the shared outcome line (see vote-outcome.ts). */
function voteLine(vote: MirrorVoteInfo): string {
    if (vote.status === "open") return "**Is this biome real?**";
    const tally = vote.scoreboard ?? { real: 0, fake: 0 };
    const verdict = vote.status !== "inconclusive" ? vote.status : tally.real + tally.fake === 0 ? "no_votes" : "tie";
    return voteOutcomeLine({ verdict, tally, decidedBy: vote.decidedBy, voters: "the Network" });
}

function section(text: string, thumbnailUrl: string | null | undefined): SectionBuilder | TextDisplayBuilder {
    const display = new TextDisplayBuilder().setContent(text);
    if (!thumbnailUrl) return display;
    return new SectionBuilder()
        .addTextDisplayComponents(display)
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: thumbnailUrl } }));
}

function voteButtonsRow(postId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${NETWORK_VOTE_PREFIX}:${postId}:real`)
            .setLabel("Real")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${NETWORK_VOTE_PREFIX}:${postId}:fake`)
            .setLabel("Fake")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Secondary),
    );
}

/** "Join Private Server", then "Join <origin>" when the origin has an invite. */
function linkButtons(post: MirrorPost): ButtonBuilder[] {
    const buttons = [
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(post.server_link).setLabel("Join Private Server").setEmoji("🔗"),
    ];
    if (post.invite_url) {
        buttons.push(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(post.invite_url).setLabel(`Join ${post.origin_name}`.slice(0, 80)),
        );
    }
    return buttons;
}

/**
 * A Network Post as it appears in one Member Server - the same shape as the local forward card: a
 * byline saying where it came from (the origin's name, linked to its invite) and the vote id, the
 * biome title, the Network vote, then the badges (🌐 Network, 🏠 in the origin's own channel, 🧪 for
 * a test) right above the buttons with their "?". Built only from parsed fields - no free text from
 * the macro reaches another server.
 */
export function buildMirrorContainer(p: MirrorParams): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(p.post.biome));
    if (p.simulated) {
        container.addTextDisplayComponents((td) => td.setContent("### 🧪 SIMULATED NETWORK POST - TESTING ONLY"));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }
    if (p.roleId && !p.home) container.addTextDisplayComponents((td) => td.setContent(`<@&${p.roleId}>`));

    const hasVote = Boolean(p.vote) && !p.simulated;
    const byline = [`From ${serverNameLink(p.post.origin_name, p.post.invite_url)}`, hasVote ? `Vote \`${p.post.id}\`` : null].filter(
        Boolean,
    );
    const name = spoofBiomeName(p.post.biome);
    const title = `## 🎉 [${name}](${p.post.server_link}) found!`;
    const heading = [`-# ${byline.join(" · ")}`, title, p.flavorText ? flavorLine(p.flavorText) : null].filter(Boolean).join("\n");
    container.spliceComponents(container.components.length, 0, section(heading, getBiomeIconUrl(p.post.biome)));

    if (p.vote && hasVote) {
        const vote = p.vote;
        container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
        container.addTextDisplayComponents((td) => td.setContent(voteLine(vote)));
        if (vote.status === "open") container.addActionRowComponents(voteButtonsRow(p.post.id));
    }

    const badges: ForwardBadges = { network: true, simulated: p.simulated, home: p.home };
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents((td) => td.setContent(forwardBadgeEmojis(badges)));
    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(...linkButtons(p.post), forwardInfoButton(badges)),
    );
    return container;
}
