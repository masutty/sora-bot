const UNIT_SECONDS = { m: 60, h: 3600 } as const;

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const BARE_OR_COMPOUND = new RegExp(`^(?:(${NUMBER})h)?(?:(${NUMBER})m)?$`);
const PLAIN_NUMBER = new RegExp(`^${NUMBER}$`);

/**
 * Reads a friendly duration into seconds: `6h`, `1h30m`, `90m`, `1.5h`, or a bare number in
 * `defaultUnit`. Returns `null` for anything else, and for zero or negative values.
 */
export function parseDuration(input: string, defaultUnit: keyof typeof UNIT_SECONDS): number | null {
    const text = input.trim().toLowerCase();
    let seconds: number;

    if (PLAIN_NUMBER.test(text)) {
        seconds = Number(text) * UNIT_SECONDS[defaultUnit];
    } else {
        const match = BARE_OR_COMPOUND.exec(text);
        if (!match || (match[1] === undefined && match[2] === undefined)) return null;
        seconds = Number(match[1] ?? 0) * UNIT_SECONDS.h + Number(match[2] ?? 0) * UNIT_SECONDS.m;
    }

    const rounded = Math.round(seconds);
    return rounded > 0 ? rounded : null;
}
