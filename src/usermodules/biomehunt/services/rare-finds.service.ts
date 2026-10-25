import { unix } from "@/utils/format";
import { formatBiomeName, getAllBiomes, getBiomeMeta, getBiomesByCategory } from "../constants/biomes.constants";
import { getRareFinds } from "../repository/activity.repository";
import { type ActivitySessionRow, type RareFind, VoteStatus } from "../types";
import { findResultLabel } from "../views/vote-outcome";

/** Every rare find of a user, newest first - fake ones included. */
export function loadRareFinds(userId: number): Promise<RareFind[]> {
    return getRareFinds(userId, getBiomesByCategory("rare"));
}

/** True when the find's newest vote ruled it fake (community or admin). */
export function isFake(f: RareFind): boolean {
    return f.vote?.status === VoteStatus.COMMUNITY_FAKE || f.vote?.status === VoteStatus.ADMIN_DENIED;
}

/** The finds that happened during a session, bounds included. */
export function findsInSession(finds: RareFind[], s: Pick<ActivitySessionRow, "started_at" | "ended_at">): RareFind[] {
    const from = s.started_at.getTime();
    const to = s.ended_at.getTime();
    return finds.filter((f) => f.at.getTime() >= from && f.at.getTime() <= to);
}

/** The biome's own badge emoji - `null` when it has none, or when `plain` and it is custom (select labels cannot render those). */
const emojiOf = (biome: string, plain: boolean): string | null => {
    const emoji = getBiomeMeta(biome)?.badgeEmoji;
    if (!emoji || (plain && /^<a?:/.test(emoji))) return null;
    return emoji;
};

/** Non-fake finds per biome in registry order, as each biome's badge emoji and count. Biomes with no badge emoji of their own are left out. */
function emojiCounts(finds: RareFind[], plain: boolean): Array<{ emoji: string; count: number }> {
    const counts = new Map<string, number>();
    for (const f of finds) if (!isFake(f)) counts.set(f.biome, (counts.get(f.biome) ?? 0) + 1);
    const keys = getAllBiomes().map((b) => b.key);
    const rank = (b: string) => (keys.includes(b) ? keys.indexOf(b) : keys.length);
    return [...counts.keys()]
        .sort((a, b) => rank(a) - rank(b))
        .flatMap((biome) => {
            const emoji = emojiOf(biome, plain);
            return emoji ? [{ emoji, count: counts.get(biome) ?? 0 }] : [];
        });
}

/** Badge emojis of the non-fake finds: repeats joined, biomes space-separated - `🔥🔥 🌸`. */
export function badgeEmojis(finds: RareFind[], plain = false): string {
    return emojiCounts(finds, plain)
        .map((c) => c.emoji.repeat(c.count))
        .join(" ");
}

/** Badge emojis of the non-fake finds with their counts - `🔥11 🌸2`. Stays short however many finds there are. */
export function badgeCounts(finds: RareFind[]): string {
    return emojiCounts(finds, false)
        .map((c) => `${c.emoji}${c.count}`)
        .join(" ");
}

/** Link to the macro's own message - the vote's `jump_link`, else built from the event and the macro channel. */
export function macroLink(guildId: string, f: RareFind): string | null {
    if (f.vote?.jumpLink) return f.vote.jumpLink;
    if (!f.macroChannelId || !f.macroMessageId || f.macroMessageId.startsWith("adm-")) return null;
    return `https://discord.com/channels/${guildId}/${f.macroChannelId}/${f.macroMessageId}`;
}

/** Link to the forward post - absent when the find had no vote. */
export function forwardLink(guildId: string, f: RareFind): string | null {
    return f.vote ? `https://discord.com/channels/${guildId}/${f.vote.channelId}/${f.vote.messageId}` : null;
}

/** `<emoji> **<Biome>**` - the name alone when the biome has no emoji. */
export function biomeTitle(biome: string): string {
    return [emojiOf(biome, false), `**${formatBiomeName(biome)}**`].filter(Boolean).join(" ");
}

/**
 * One find as a bullet: `- <emoji> **<Biome>**` (+ the finder's mention), then an indented subtext line with its
 * result, time and links - the top line stays short so it never wraps, whoever decided the vote.
 * `finderId` adds the finder's mention after the biome; `time` is the timestamp style (`t` = time of day, `R` = relative).
 */
export function formatFindLine(guildId: string, f: RareFind, opts: { finderId?: string; time?: "t" | "R" } = {}): string {
    const head = [biomeTitle(f.biome), opts.finderId && `<@${opts.finderId}>`].filter(Boolean).join(" · ");
    const macro = macroLink(guildId, f);
    const forward = forwardLink(guildId, f);
    const sub = [
        findResultLabel(f.vote),
        `<t:${unix(f.at)}:${opts.time ?? "t"}>`,
        macro && `[Macro message](${macro})`,
        forward && `[Forward](${forward})`,
    ].filter(Boolean);
    return `- ${head}\n  -# ${sub.join(" · ")}`;
}
