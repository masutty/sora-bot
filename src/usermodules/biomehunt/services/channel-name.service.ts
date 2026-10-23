import { DEFAULT_BADGE_EMOJI, plainBadgeEmoji } from "../constants/badges.constants";
import { getAllBiomes } from "../constants/biomes.constants";
import { getClosedRareCounts } from "../repository/users.repository";
import { macroChannelName } from "./macro-channel.service";

/** Discord's channel name limit. */
const MAX_NAME_LENGTH = 100;

export type RareCounts = Array<{ biome: string; count: number }>;

/** A biome's configured badge emoji if a channel name can show it (unicode) - `null` when unset or custom (`<:x:id>`). */
function channelBadgeEmoji(emoji: string | null | undefined): string | null {
    return emoji && !/^<a?:/.test(emoji) ? emoji : null;
}

/** `<emoji><count>` per rare biome with a count above 0 and its own badge emoji, in registry order - `🔥3🌸1`. Empty when there is none. */
export function rareBadgeString(counts: RareCounts): string {
    const byBiome = new Map(counts.map((c) => [c.biome, c.count]));
    return getAllBiomes()
        .filter((b) => (byBiome.get(b.key) ?? 0) > 0 && channelBadgeEmoji(b.badgeEmoji))
        .map((b) => `${channelBadgeEmoji(b.badgeEmoji)}${byBiome.get(b.key)}`)
        .join("");
}

/** The name minus a leading run of badge tokens (`<rare badge emoji><digits>`) - what a rename left behind when its badges were never stored. */
function stripBadgeTokens(name: string): string {
    const emojis = [
        ...new Set([
            DEFAULT_BADGE_EMOJI,
            ...getAllBiomes()
                .filter((b) => b.category === "rare")
                .map((b) => plainBadgeEmoji(b.badgeEmoji)),
        ]),
    ];
    let rest = name;
    for (;;) {
        const emoji = emojis.find((e) => rest.startsWith(e));
        const digits = emoji ? /^[0-9]+/.exec(rest.slice(emoji.length))?.[0] : undefined;
        if (!emoji || !digits) return rest;
        rest = rest.slice(emoji.length + digits.length);
    }
}

/**
 * The name a macro channel should have: `badges` + its base. The base is the current name minus the
 * stored badges prefix; a name that doesn't start with them (an admin rename) keeps its text, minus
 * any leading badge tokens a half-saved rename left. The base is cut to fit 100 characters, the badges never.
 */
export function wantedChannelName(current: string, storedBadges: string, badges: string): string {
    const base = storedBadges && current.startsWith(storedBadges) ? current.slice(storedBadges.length) : stripBadgeTokens(current);
    const room = Math.max(0, MAX_NAME_LENGTH - badges.length);
    return `${badges}${Array.from(base).reduce((out, ch) => (out.length + ch.length <= room ? out + ch : out), "")}`;
}

export interface InitialNameDeps {
    getCounts(userIds: number[]): Promise<Map<number, RareCounts>>;
}

/** The name (and the badges inside it) for a macro channel being created or adopted. A failed lookup gives today's plain name. */
export async function initialChannelName(
    flagOn: boolean,
    userId: number,
    username: string,
    deps: InitialNameDeps = { getCounts: getClosedRareCounts },
): Promise<{ name: string; badges: string }> {
    const base = macroChannelName(username);
    if (!flagOn) return { name: base, badges: "" };
    try {
        const badges = rareBadgeString((await deps.getCounts([userId])).get(userId) ?? []);
        return { name: wantedChannelName(base, "", badges), badges };
    } catch {
        return { name: base, badges: "" };
    }
}
