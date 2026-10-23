import { ContainerBuilder } from "discord.js";
import { DEFAULT_BADGE_EMOJI } from "../constants/badges.constants";
import { formatBiomeName, getBiomeMeta } from "../constants/biomes.constants";
import type { Badge } from "../types";
import { VoteStatus } from "../types";

const RED = 0xda373c;

export interface FakeFindInput {
    /** `member` is the macro-channel post ("your"), `log` the log-channel post ("their"). */
    audience: "member" | "log";
    biome: string;
    finderDiscordId: string;
    at: Date;
    status: VoteStatus.COMMUNITY_FAKE | VoteStatus.ADMIN_DENIED;
    decidedBy: string | null;
    tally: { real: number; fake: number };
    seedsReverted: number;
    xpReverted: number;
    revokedBadge: Badge | null;
    forwardLink: string;
}

const badgeEmoji = (badge: Badge) => getBiomeMeta(badge)?.badgeEmoji || DEFAULT_BADGE_EMOJI;

/** The blockquote and the list of what happened - the log post puts them under its own bold title. */
export function buildFakeFindBody(input: FakeFindInput): string {
    const biome = formatBiomeName(input.biome);
    const verdict =
        input.status === VoteStatus.ADMIN_DENIED
            ? `Denied by <@${input.decidedBy}>`
            : `Voted fake \`✅ ${input.tally.real}\` \`❌ ${input.tally.fake}\``;
    const quote = [
        `> ${badgeEmoji(input.biome)} **${biome}** · <t:${Math.floor(input.at.getTime() / 1000)}:f>`,
        ...(input.audience === "log" ? [`> <@${input.finderDiscordId}>`] : []),
        `> ${verdict}`,
    ];

    const list = [`- Removed from ${input.audience === "member" ? "your" : "their"} biomes`];
    if (input.status === VoteStatus.ADMIN_DENIED) {
        const taken = [
            input.seedsReverted > 0 && `\`${input.seedsReverted} 🌱\``,
            input.xpReverted > 0 && `\`${input.xpReverted} XP\``,
        ].filter(Boolean);
        if (taken.length > 0) list.push(`- ${taken.join(" ")} taken back`);
        if (input.revokedBadge) list.push(`- Lost the ${badgeEmoji(input.revokedBadge)} ${formatBiomeName(input.revokedBadge)} badge`);
    } else {
        list.push("- No Seeds, XP or badge given");
    }
    return `${quote.join("\n")}\n\n${list.join("\n")}`;
}

/** The subtext line; `fakefind` is the search keyword. */
export const fakeFindFooter = (forwardLink: string) => `fakefind · [Forward](${forwardLink})`;

/** The "fake find" report: red container, quote of the find, then what the ruling did. */
export function buildFakeFindContainer(input: FakeFindInput): ContainerBuilder {
    const title = input.audience === "member" ? "## ❌ Fake find" : "**❌ Fake find**";
    return new ContainerBuilder()
        .setAccentColor(RED)
        .addTextDisplayComponents((td) => td.setContent(`${title}\n${buildFakeFindBody(input)}`))
        .addTextDisplayComponents((td) => td.setContent(`-# ${fakeFindFooter(input.forwardLink)}`));
}
