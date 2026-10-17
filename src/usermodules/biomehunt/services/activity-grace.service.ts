import { getBiomeMeta } from "../constants/biomes.constants";
import type { ActivityGrace, ParsedEvent } from "../types";

export const NO_GRACE: ActivityGrace = { until: null, biome: null };

/**
 * The moment a user's activity is measured from - their last macro message, or the end of their
 * activity grace if that's later. Timed biomes (admin events, mostly) can run longer than the idle
 * threshold with the macro silent, so while one runs the user must not go idle nor have their
 * session split; once it's over, the normal idle threshold counts from its expected end.
 */
export function effectiveLastActivity(lastActivityAt: Date | null, graceUntil: Date | null): Date | null {
    if (!lastActivityAt) return graceUntil;
    if (!graceUntil) return lastActivityAt;
    return graceUntil > lastActivityAt ? graceUntil : lastActivityAt;
}

/**
 * The grace after a macro event. Only the most recently started biome counts (Biome Randomizer /
 * Strange Controller can chain them): a Started of a biome with a `durationS` grants
 * `now + durationS`, a Started of any other biome drops the grace. An Ended of the grace's own biome
 * ends it early - not every macro sends Ended, so the next Started also does. Anything else keeps it.
 */
export function nextActivityGrace(current: ActivityGrace, event: Pick<ParsedEvent, "biome" | "eventType">, now: Date): ActivityGrace {
    if (!event.biome) return current;
    if (event.eventType === "started") {
        const durationS = getBiomeMeta(event.biome)?.durationS;
        return durationS ? { until: new Date(now.getTime() + durationS * 1000), biome: event.biome } : NO_GRACE;
    }
    if (event.eventType === "ended" && current.biome === event.biome) return NO_GRACE;
    return current;
}
