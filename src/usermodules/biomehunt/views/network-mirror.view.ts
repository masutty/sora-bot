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
import { type ForwardBadges, forwardBadgeEmojis, forwardInfoButton } from "./forward-post.view";

/** Customid prefix of the Real/Fake buttons on a Mirror - routed by `network-vote.component.ts`. */
export const NETWORK_VOTE_PREFIX = "biomehunt:net-vote";

/** The post fields a Mirror is built from - its render snapshot, never re-derived. */
export type MirrorPost = Pick<NetworkPostRow, "id" | "biome" | "origin_name" | "origin_icon_url" | "invite_url" | "server_link">;

export interface Scoreboard {
    /** Servers whose members' majority went each way (ties abstain). */
    servers: { real: number; fake: number };
    /** Every ballot, across all servers. */
    people: { real: number; fake: number };
}

export interface MirrorVoteInfo {
    status: NetworkVoteStatus;
    /** Shown once the vote is closed. */
    scoreboard?: Scoreboard;
}

export interface MirrorParams {
    post: MirrorPost;
    /** This Member Server's ping role for the biome - shown (and allowed to ping) only on the first send. */
    roleId: string | null;
    vote?: MirrorVoteInfo;
    /** A test (`simulate-biome network` / `network_relays`) - marked, no vote. */
    simulated?: boolean;
}

const plural = (n: number, word: string) => `**${n}** ${word}${n === 1 ? "" : "s"}`;

export function formatScoreboard(s: Scoreboard): string {
    return `✅ Real ${plural(s.servers.real, "server")} (${s.people.real}) · ❌ Fake ${plural(s.servers.fake, "server")} (${s.people.fake})`;
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

function voteLine(vote: MirrorVoteInfo): string {
    const board = vote.scoreboard ? `\n${formatScoreboard(vote.scoreboard)}` : "";
    switch (vote.status) {
        case "open":
            return "**Is this biome real?**";
        case "real":
            return `✅ The Network voted this real${board}`;
        case "fake":
            return `❌ The Network voted this fake${board}`;
        case "inconclusive":
            return `⚖️ Not enough servers decided${board}`;
    }
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

/**
 * A Network Post as it appears in one Member Server - the same shape as the local forward card: a
 * byline saying where it came from (the origin's name, linked to its invite), the biome title, the
 * Network vote while open, then the badges (🌐 Network, plus 🧪 for a test) right above the buttons
 * with their "?". Built only from parsed fields - no free text from the macro reaches another server.
 */
export function buildMirrorContainer(p: MirrorParams): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(p.post.biome));
    if (p.simulated) {
        container.addTextDisplayComponents((td) => td.setContent("### 🧪 SIMULATED NETWORK POST - TESTING ONLY"));
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }
    if (p.roleId) container.addTextDisplayComponents((td) => td.setContent(`<@&${p.roleId}>`));

    const name = spoofBiomeName(p.post.biome);
    const heading = `-# From ${serverNameLink(p.post.origin_name, p.post.invite_url)}\n## 🎉 [${name}](${p.post.server_link}) found!`;
    container.spliceComponents(container.components.length, 0, section(heading, getBiomeIconUrl(p.post.biome)));

    if (p.vote && !p.simulated) {
        container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
        container.addTextDisplayComponents((td) => td.setContent(voteLine(p.vote as MirrorVoteInfo)));
        if (p.vote.status === "open") container.addActionRowComponents(voteButtonsRow(p.post.id));
    }

    const badges: ForwardBadges = { network: true, simulated: p.simulated };
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents((td) => td.setContent(forwardBadgeEmojis(badges)));
    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(p.post.server_link).setLabel("Join Private Server").setEmoji("🔗"),
            forwardInfoButton(badges),
        ),
    );
    return container;
}
