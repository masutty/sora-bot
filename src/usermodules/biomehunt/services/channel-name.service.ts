import { DEFAULT_BADGE_EMOJI } from "../constants/badges.constants";
import { getAllBiomes } from "../constants/biomes.constants";
import { getClosedRareCounts } from "../repository/users.repository";
import { macroChannelName } from "./macro-channel.service";

/** Discord's channel name limit. */
const MAX_NAME_LENGTH = 100;

export type RareCounts = Array<{ biome: string; count: number }>;

/** `<emoji><count>` per rare biome with a count above 0, in registry order - `🔥3🌸1`. Empty when there is none. */
export function rareBadgeString(counts: RareCounts): string {
    const byBiome = new Map(counts.map((c) => [c.biome, c.count]));
    return getAllBiomes()
        .filter((b) => (byBiome.get(b.key) ?? 0) > 0)
        .map((b) => `${b.badgeEmoji || DEFAULT_BADGE_EMOJI}${byBiome.get(b.key)}`)
        .join("");
}

/**
 * The name a macro channel should have: `badges` + its base. The base is the current name minus the
 * stored badges prefix; a name that doesn't start with them (an admin rename) is kept whole. The
 * base is cut to fit 100 characters, the badges never.
 */
export function wantedChannelName(current: string, storedBadges: string, badges: string): string {
    const base = storedBadges && current.startsWith(storedBadges) ? current.slice(storedBadges.length) : current;
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
