import { type BiomeCategory, BiomeHuntError } from "../types";

export const ALL_BIOME_CATEGORIES: BiomeCategory[] = ["biome", "weather", "rare", "event"];

export const BIOME_CATEGORY_LABELS: Record<BiomeCategory, string> = {
    biome: "Biome",
    weather: "Weather",
    rare: "Rare",
    event: "Event",
};

interface BiomeMeta {
    label: string;
    category: BiomeCategory;
    color: number;
    /** Optional icon shown next to the biome name on its forward notification. Unset = no image. */
    iconUrl?: string;
    /** Raw ANSI escape prefix (e.g. `"\u001b[1;33m"`) used to color this biome's name in the
     * session-end report's `ansi` codeblock (see `ansiBiomeLine` in services/activity-session-report.service.ts).
     * Unset = no color (terminal default). Discord's `ansi` codeblock only renders bold(1) plus
     * 8 foreground (30-37) and 8 background (40-47) codes - see `!test embed/ansi-colors`. */
    ansiColor?: string;
}

/**
 * SINGLE SOURCE OF TRUTH for every recognized biome, keyed by its canonical space-less
 * uppercase form (how it's stored/matched - see `normalizeBiomeName` in macro-parsers/default-macro.parser.ts).
 * To add/rename/recolor/recategorize/reicon a biome, edit it here - everything else
 * (recognition, display name, category grouping, forward notification color/icon, session-end
 * ANSI color) reads from this one object. Anything not listed here falls back to a generic Title
 * Case display name, no category match, the default accent color, no icon, and no ANSI color.
 */
export const BIOME_META: Record<string, BiomeMeta> = {
    WINDY: { label: "Windy", category: "weather", color: 0xa9dfff, iconUrl: "https://i.imgur.com/GD9ppHZ.png", ansiColor: "\u001b[36m" },
    SNOWY: { label: "Snowy", category: "weather", color: 0xdfffff, iconUrl: "https://i.imgur.com/8rXSIQ0.png", ansiColor: "\u001b[37m" },
    RAINY: { label: "Rainy", category: "weather", color: 0x3a6ea5, iconUrl: "https://i.imgur.com/KYblZp4.png", ansiColor: "\u001b[34m" },
    SANDSTORM: {
        label: "Sand Storm",
        category: "biome",
        color: 0xe0c068,
        iconUrl: "https://i.imgur.com/gBJQViw.png",
        ansiColor: "\u001b[33m",
    },
    HELL: { label: "Hell", category: "biome", color: 0xd7263d, iconUrl: "https://i.imgur.com/qf4ih2k.png", ansiColor: "\u001b[31m" },
    STARFALL: {
        label: "Starfall",
        category: "biome",
        color: 0x6c5ce7,
        iconUrl: "https://i.imgur.com/KDlFLf3.png",
        ansiColor: "\u001b[34m",
    },
    HEAVEN: { label: "Heaven", category: "biome", color: 0xffd700, iconUrl: "https://i.imgur.com/y6OXzVv.png", ansiColor: "\u001b[33m" },
    CORRUPTION: {
        label: "Corruption",
        category: "biome",
        color: 0x4b0082,
        iconUrl: "https://i.imgur.com/lzlsuC6.png",
        ansiColor: "\u001b[35m",
    },
    NULL: { label: "Null", category: "biome", color: 0x2c2f33, iconUrl: "https://i.imgur.com/krutokU.png", ansiColor: "\u001b[30m" },
    GLITCHED: {
        label: "Glitched",
        category: "rare",
        color: 0xff00ff,
        iconUrl: "https://i.imgur.com/xTd6Ku4.png",
        ansiColor: "\u001b[1;32;40m",
    },
    CYBERSPACE: {
        label: "Cyberspace",
        category: "rare",
        color: 0x00e5ff,
        iconUrl: "https://i.imgur.com/FxFEobX.png",
        ansiColor: "\u001b[1;34;40m",
    },
    DREAMSPACE: {
        label: "Dreamspace",
        category: "rare",
        color: 0xffb6d9,
        iconUrl: "https://i.imgur.com/JCoQDvY.png",
        ansiColor: "\u001b[1;37;45m",
    },
    SINGULARITY: {
        label: "Singularity",
        category: "rare",
        color: 0x0a0a0a,
        iconUrl: "https://i.imgur.com/rBoV7lJ.png",
        ansiColor: "\u001b[1;31;40m",
    },
    PUMPKINMOON: {
        label: "Pumpkin Moon",
        category: "event",
        color: 0xff8c00,
        iconUrl: "https://i.imgur.com/wEdcqqI.png",
        ansiColor: "\u001b[1;33m",
    },
    GRAVEYARD: {
        label: "Graveyard",
        category: "event",
        color: 0x556b2f,
        iconUrl: "https://i.imgur.com/MrKZqUx.png",
        ansiColor: "\u001b[1;33m",
    },
    BLAZINGSUN: {
        label: "Blazing Sun",
        category: "event",
        color: 0xff4500,
        iconUrl: "https://i.imgur.com/BMKWWJ3.png",
        ansiColor: "\u001b[1;33m",
    },
    INCINERATOR: { label: "Incinerator", category: "event", color: 0xff4500, iconUrl: "", ansiColor: "\u001b[1;33m" },
    BLOODRAIN: {
        label: "Blood Rain",
        category: "event",
        color: 0x8b0000,
        iconUrl: "https://i.imgur.com/w8oVQ8e.png",
        ansiColor: "\u001b[1;33m",
    },
    AURORA: { label: "Aurora", category: "event", color: 0x00fa9a, iconUrl: "https://i.imgur.com/nS7GTo1.png", ansiColor: "\u001b[1;33m" },
    EGGLAND: {
        label: "Eggland",
        category: "event",
        color: 0xf5deb3,
        iconUrl: "https://i.imgur.com/vkQwGrz.png",
        ansiColor: "\u001b[1;33m",
    },
};

export function getBiomeIconUrl(biome: string): string | undefined {
    return BIOME_META[biome]?.iconUrl;
}

export function formatBiomeName(biome: string): string {
    const known = BIOME_META[biome]?.label;
    if (known) return known;
    return biome.charAt(0) + biome.slice(1).toLowerCase();
}

const ZERO_WIDTH_SPACE = "​";

/**
 * Same display name as `formatBiomeName`, but with a zero-width space spliced into the middle -
 * invisible to a human reader, but breaks naive exact-substring text scraping ("snipe bots"
 * watching forward channels for a biome name). Only "somewhat" effective - anything that
 * strips zero-width characters before matching defeats it. Used only where a forward is
 * actually rendered, not for internal displays (profile, admin listings, etc.) where spoofing
 * would just be pointless clutter.
 */
export function spoofBiomeName(biome: string): string {
    const label = formatBiomeName(biome);
    if (label.length < 2) return label;
    const mid = Math.ceil(label.length / 2);
    return label.slice(0, mid) + ZERO_WIDTH_SPACE + label.slice(mid);
}

export function getBiomesByCategory(category: BiomeCategory): string[] {
    return Object.entries(BIOME_META)
        .filter(([, meta]) => meta.category === category)
        .map(([biome]) => biome);
}

/**
 * Resolves a biome selector - either one concrete biome key, `CAT:<category>` for every biome
 * in that category, or `ALL` for every known biome - into the list of concrete biome keys it
 * targets. Used wherever an admin can quick-apply a forward to a whole group at once.
 */
export function resolveBiomeSelector(selector: string): string[] {
    if (selector === "ALL") return Object.keys(BIOME_META);
    if (selector.startsWith("CAT:")) return getBiomesByCategory(selector.slice(4) as BiomeCategory);
    if (!(selector in BIOME_META)) throw new BiomeHuntError(`Unknown biome: ${selector}`);
    return [selector];
}

/** Ready-made choice list (quick categories first, then every individual biome) for biome selectors in UI. */
export const BIOME_SELECTOR_CHOICES: Array<{ name: string; value: string }> = [
    { name: "All", value: "ALL" },
    ...ALL_BIOME_CATEGORIES.map((category) => ({ name: `All ${BIOME_CATEGORY_LABELS[category]}`, value: `CAT:${category}` })),
    ...Object.entries(BIOME_META).map(([value, meta]) => ({ name: meta.label, value })),
];

/** Individual biomes only (no ALL/category shortcuts) - used where a single concrete biome is required, e.g. correcting one user's find count. */
export const BIOME_ONLY_CHOICES: Array<{ name: string; value: string }> = Object.entries(BIOME_META).map(([value, meta]) => ({
    name: meta.label,
    value,
}));

const DEFAULT_BIOME_COLOR = 0x5865f2;

export function getBiomeColor(biome: string): number {
    return BIOME_META[biome]?.color ?? DEFAULT_BIOME_COLOR;
}

/** Unset = no ANSI color applied - the biome's name prints in the codeblock's default color. */
export function getBiomeAnsiColor(biome: string): string {
    return BIOME_META[biome]?.ansiColor ?? "";
}
