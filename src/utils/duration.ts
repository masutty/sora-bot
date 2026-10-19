const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1 } as const;

/** Parts in order: `1d 6h 30m 10s`, any subset, spaces between parts optional. */
const COMPOUND = /^(?:(\d+(?:\.\d+)?)d\s*)?(?:(\d+(?:\.\d+)?)h\s*)?(?:(\d+(?:\.\d+)?)m\s*)?(?:(\d+(?:\.\d+)?)s)?$/;
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * Reads a friendly duration into seconds: `6h`, `1h30m`, `1h 30m`, `1d 6h`, `30s`, `1.5h`, or a
 * bare number in `defaultUnit`. Accepts the same shape `formatTime` prints. Returns `null` for
 * anything else, and for zero or negative values.
 */
export function parseDuration(input: string, defaultUnit: "m" | "h"): number | null {
    const text = input.trim().toLowerCase();
    let seconds: number;

    if (PLAIN_NUMBER.test(text)) {
        seconds = Number(text) * UNIT_SECONDS[defaultUnit];
    } else {
        const match = COMPOUND.exec(text);
        if (!match || match.slice(1).every((part) => part === undefined)) return null;
        const [, days, hours, minutes, secs] = match;
        seconds =
            Number(days ?? 0) * UNIT_SECONDS.d +
            Number(hours ?? 0) * UNIT_SECONDS.h +
            Number(minutes ?? 0) * UNIT_SECONDS.m +
            Number(secs ?? 0) * UNIT_SECONDS.s;
    }

    const rounded = Math.round(seconds);
    return rounded > 0 ? rounded : null;
}
