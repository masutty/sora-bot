import { type BiomeCategory, BiomeHuntError } from "../types";

export const ALL_BIOME_CATEGORIES: BiomeCategory[] = ["biome", "weather", "rare", "event", "admin"];

export const BIOME_CATEGORY_LABELS: Record<BiomeCategory, string> = {
    biome: "Biome",
    weather: "Weather",
    rare: "Rare",
    event: "Event",
    admin: "Admin",
};

export interface BiomeMeta {
    label: string;
    category: BiomeCategory;
    color: number;
    /** Optional in-game style line shown under the biome's title on its forward card. Unset = no line. */
    flavorText?: string;
    /** Optional icon shown next to the biome name on its forward notification. Unset = no image. */
    iconUrl?: string;
    /** Raw ANSI escape prefix (e.g. `"\u001b[1;33m"`) used to color this biome's name in the
     * session-end report's `ansi` codeblock (see `ansiBiomeLine` in services/activity.service.ts).
     * Unset = no color (terminal default). Discord's `ansi` codeblock only renders bold(1) plus
     * 8 foreground (30-37) and 8 background (40-47) codes - see `!test embed/ansi-colors`. */
    ansiColor?: string;
    /** How long the biome lasts, for biomes with a fixed duration (admin events, mostly). While it
     * runs, its finder can't go idle - see activity.service.ts. Unset = not timed. */
    durationS?: number;
    /** Finding this biome earns a permanent profile badge (and the guild's badge role, if set). */
    hasBadge?: boolean;
    /** The badge's emoji - unicode or a custom `<:name:id>`. Unset = the default badge emoji. */
    badgeEmoji?: string;
}

/** One registered biome. A disabled biome is no longer recognized from macro webhooks nor offered
 * in any picker, but keeps its label/color/category so old finds still display correctly. */
export interface BiomeEntry extends BiomeMeta {
    /** Canonical space-less uppercase form - how it's stored/matched (see `normalizeBiomeName`). */
    key: string;
    enabled: boolean;
}

/**
 * The biomes the bot shipped with - only a SEED now. The live list is the `bh_biomes` table,
 * managed by the bot owner with `/owner biome ...` (see repository/biomes.repository.ts): on
 * boot every key here that's missing from the table is inserted, and rows already there are never
 * overwritten. To add/edit a biome, use the command - editing an entry here does nothing on a
 * database that already has it.
 */
export const DEFAULT_BIOMES: Record<string, BiomeMeta> = {
    WINDY: {
        label: "Windy",
        flavorText: "A refreshing and cool wind passes through the world...",
        category: "weather",
        color: 0xa9dfff,
        iconUrl: "https://i.imgur.com/GD9ppHZ.png",
        ansiColor: "\u001b[36m",
    },
    SNOWY: {
        label: "Snowy",
        flavorText: "White snow and cold begin to cover the surroundings...",
        category: "weather",
        color: 0xdfffff,
        iconUrl: "https://i.imgur.com/8rXSIQ0.png",
        ansiColor: "\u001b[37m",
    },
    RAINY: {
        label: "Rainy",
        flavorText: "Strong winds and showers sweep through the world...",
        category: "weather",
        color: 0x3a6ea5,
        iconUrl: "https://i.imgur.com/KYblZp4.png",
        ansiColor: "\u001b[34m",
    },
    SANDSTORM: {
        label: "Sand Storm",
        flavorText: "A harsh Sand Storm blocks your path...",
        category: "biome",
        color: 0xe0c068,
        iconUrl: "https://i.imgur.com/gBJQViw.png",
        ansiColor: "\u001b[33m",
    },
    HELL: {
        label: "Hell",
        flavorText: "A strong and violent energy of chaos overtakes the world...",
        category: "biome",
        color: 0xd7263d,
        iconUrl: "https://i.imgur.com/qf4ih2k.png",
        ansiColor: "\u001b[31m",
    },
    STARFALL: {
        label: "Starfall",
        flavorText: "Beautiful and dreamy starlight pours into the world...",
        category: "biome",
        color: 0x6c5ce7,
        iconUrl: "https://i.imgur.com/KDlFLf3.png",
        ansiColor: "\u001b[34m",
    },
    HEAVEN: {
        label: "Heaven",
        flavorText: "A hand of angel leads you into divine place...",
        category: "biome",
        color: 0xffd700,
        iconUrl: "https://i.imgur.com/y6OXzVv.png",
        ansiColor: "\u001b[33m",
    },
    CORRUPTION: {
        label: "Corruption",
        flavorText: "Poisonous pollution spreads throughout the world...",
        category: "biome",
        color: 0x4b0082,
        iconUrl: "https://i.imgur.com/lzlsuC6.png",
        ansiColor: "\u001b[35m",
    },
    NULL: {
        label: "Null",
        flavorText: "It's too dark here...",
        category: "biome",
        color: 0x2c2f33,
        iconUrl: "https://i.imgur.com/krutokU.png",
        ansiColor: "\u001b[30m",
    },
    GLITCHED: {
        label: "Glitched",
        flavorText: "Unexpected error occurred. [Code 404]",
        category: "rare",
        color: 0xff00ff,
        iconUrl: "https://i.imgur.com/xTd6Ku4.png",
        ansiColor: "\u001b[1;32;40m",
        hasBadge: true,
        badgeEmoji: "🔥",
    },
    CYBERSPACE: {
        label: "Cyberspace",
        flavorText: "Signal_Received | From: Island_SOL",
        category: "rare",
        color: 0x00e5ff,
        iconUrl: "https://i.imgur.com/FxFEobX.png",
        ansiColor: "\u001b[1;34;40m",
        hasBadge: true,
        badgeEmoji: "🌐",
    },
    DREAMSPACE: {
        label: "Dreamspace",
        flavorText: "You begin to feel sleepy...",
        category: "rare",
        color: 0xffb6d9,
        iconUrl: "https://i.imgur.com/JCoQDvY.png",
        ansiColor: "\u001b[1;37;45m",
        hasBadge: true,
        badgeEmoji: "🌸",
    },
    SINGULARITY: {
        label: "Singularity",
        flavorText: "The Singularity pulls in everything, including you...",
        category: "rare",
        color: 0x0a0a0a,
        iconUrl: "https://i.imgur.com/rBoV7lJ.png",
        ansiColor: "\u001b[1;31;40m",
    },
    PUMPKINMOON: {
        label: "Pumpkin Moon",
        flavorText: "An evil and eerie energy has taken over the world!",
        category: "event",
        color: 0xff8c00,
        iconUrl: "https://i.imgur.com/wEdcqqI.png",
        ansiColor: "\u001b[1;33m",
    },
    GRAVEYARD: {
        label: "Graveyard",
        flavorText: "Nameless ghosts past by you...",
        category: "event",
        color: 0x556b2f,
        iconUrl: "https://i.imgur.com/MrKZqUx.png",
        ansiColor: "\u001b[1;33m",
    },
    BLAZINGSUN: {
        label: "Blazing Sun",
        flavorText: "The hot sunlight begins to shine on you.",
        category: "event",
        color: 0xff4500,
        iconUrl: "https://i.imgur.com/BMKWWJ3.png",
        ansiColor: "\u001b[1;33m",
    },
    INCINERATOR: {
        label: "Incinerator",
        flavorText: "It's hotter than usual today! It's a heatwave!",
        category: "event",
        color: 0xff4500,
        iconUrl: "",
        ansiColor: "\u001b[1;33m",
    },
    BLOODRAIN: {
        label: "Blood Rain",
        flavorText: "Drops of blood begin to fall from the sky...",
        category: "event",
        color: 0x8b0000,
        iconUrl: "https://i.imgur.com/w8oVQ8e.png",
        ansiColor: "\u001b[1;33m",
    },
    AURORA: {
        label: "Aurora",
        flavorText: "An aurora begins to appear in the sky...",
        category: "event",
        color: 0x00fa9a,
        iconUrl: "https://i.imgur.com/nS7GTo1.png",
        ansiColor: "\u001b[1;33m",
    },
    EGGLAND: {
        label: "Eggland",
        category: "event",
        color: 0xf5deb3,
        iconUrl: "https://i.imgur.com/vkQwGrz.png",
        ansiColor: "\u001b[1;33m",
    },
};

/**
 * The form every biome key is stored in: uppercase letters and digits only. Macros write names with
 * spaces and punctuation ("SAND STORM", "THE NULL'S EXISTENCE") - all of it is dropped, so
 * `THE NULL'S EXISTENCE` -> `THENULLSEXISTENCE`.
 */
export function normalizeBiomeName(raw: string): string {
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function defaultEntries(): BiomeEntry[] {
    return Object.entries(DEFAULT_BIOMES).map(([key, meta]) => ({ ...meta, key, hasBadge: meta.hasBadge === true, enabled: true }));
}

/**
 * SINGLE SOURCE OF TRUTH for every recognized biome at runtime - recognition, display name,
 * category grouping, forward color/icon/flavor text and session-end ANSI color all read from it.
 * Starts as `DEFAULT_BIOMES` (so tests and the first moments of boot work without a database) and
 * is replaced by `loadBiomeRegistry` on boot and after every `/owner biome` change. Anything not
 * in it falls back to a generic Title Case display name, no category, the default accent color, no
 * icon and no ANSI color.
 */
let registry = new Map<string, BiomeEntry>(defaultEntries().map((e) => [e.key, e]));

/** Replaces the whole registry, keeping the given order (the order every picker shows). */
export function setBiomeRegistry(entries: BiomeEntry[]): void {
    registry = new Map(entries.map((e) => [e.key, e]));
}

/** Test helper - puts the registry back to `DEFAULT_BIOMES`. */
export function resetBiomeRegistry(): void {
    setBiomeRegistry(defaultEntries());
}

/** The biome's metadata, disabled ones included - for displaying something already recorded. */
export function getBiomeMeta(biome: string): BiomeEntry | undefined {
    return registry.get(biome);
}

/** Every registered biome, disabled ones included, in registry order. */
export function getAllBiomes(): BiomeEntry[] {
    return [...registry.values()];
}

/** Every biome currently recognized and offered in pickers, in registry order. */
export function getEnabledBiomes(): BiomeEntry[] {
    return getAllBiomes().filter((e) => e.enabled);
}

/** Whether a (normalized) biome key is one the bot currently recognizes. */
export function isKnownBiome(biome: string): boolean {
    return registry.get(biome)?.enabled === true;
}

export function getBiomeIconUrl(biome: string): string | undefined {
    return registry.get(biome)?.iconUrl;
}

export function formatBiomeName(biome: string): string {
    const known = registry.get(biome)?.label;
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

/** Enabled biomes of one category. */
export function getBiomesByCategory(category: BiomeCategory): string[] {
    return getEnabledBiomes()
        .filter((e) => e.category === category)
        .map((e) => e.key);
}

/**
 * Resolves a biome selector - either one concrete biome key, `CAT:<category>` for every biome
 * in that category, or `ALL` for every known biome - into the list of concrete biome keys it
 * targets. Used wherever an admin can quick-apply a forward to a whole group at once.
 */
export function resolveBiomeSelector(selector: string): string[] {
    if (selector === "ALL") return getEnabledBiomes().map((e) => e.key);
    if (selector.startsWith("CAT:")) {
        const category = selector.slice(4) as BiomeCategory;
        if (!ALL_BIOME_CATEGORIES.includes(category)) throw new BiomeHuntError(`Unknown biome category: ${category}`);
        return getBiomesByCategory(category);
    }
    if (!isKnownBiome(selector)) throw new BiomeHuntError(`Unknown biome: ${selector}`);
    return [selector];
}

export interface BiomeChoice {
    name: string;
    value: string;
}

/** The `ALL` / `CAT:<category>` shortcuts `resolveBiomeSelector` accepts. */
export function getBiomeGroupChoices(): BiomeChoice[] {
    return [
        { name: "All", value: "ALL" },
        ...ALL_BIOME_CATEGORIES.map((category) => ({ name: `All ${BIOME_CATEGORY_LABELS[category]}`, value: `CAT:${category}` })),
    ];
}

/** Individual enabled biomes only (no ALL/category shortcuts) - where a single concrete biome is required. */
export function getBiomeOnlyChoices(): BiomeChoice[] {
    return getEnabledBiomes().map((e) => ({ name: e.label, value: e.key }));
}

/** Discord's cap on autocomplete suggestions and on select menu options. */
export const MAX_DISCORD_CHOICES = 25;

export interface BiomeAutocompleteOptions {
    /** Also suggest the `ALL` / `CAT:<category>` shortcuts (for options passed to `resolveBiomeSelector`). */
    selectors?: boolean;
    /** Which biomes to suggest - default `"enabled"`. */
    which?: "enabled" | "disabled" | "all";
}

/**
 * Autocomplete suggestions for a biome option: every choice whose name or key contains what the
 * user typed so far (case-insensitive), capped at Discord's 25. Replaces fixed `.addChoices()`,
 * which can't follow a biome list that changes at runtime and tops out at 25 entries.
 */
export function biomeAutocompleteChoices(
    typed: string,
    { selectors = false, which = "enabled" }: BiomeAutocompleteOptions = {},
): BiomeChoice[] {
    const pool =
        which === "enabled" ? getEnabledBiomes() : which === "disabled" ? getAllBiomes().filter((e) => !e.enabled) : getAllBiomes();
    const biomes = pool.map((e) => ({ name: e.enabled ? e.label : `${e.label} (disabled)`, value: e.key }));
    const choices = selectors ? [...getBiomeGroupChoices(), ...biomes] : biomes;
    const needle = typed.trim().toLowerCase();
    return choices
        .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle))
        .slice(0, MAX_DISCORD_CHOICES);
}

const DEFAULT_BIOME_COLOR = 0x5865f2;

export function getBiomeColor(biome: string): number {
    return registry.get(biome)?.color ?? DEFAULT_BIOME_COLOR;
}

/**
 * Whether a find gets its rewards the moment it's detected - every one but a rare find, which waits
 * for its community vote (see biome-vote.service.ts). An admin find's only possible reward is its
 * biome badge: `grantBiomeReward` never gives Seeds/XP for the admin category.
 */
export function rewardsOnDetection(biome: string): boolean {
    return registry.get(biome)?.category !== "rare";
}

/** Unset = no ANSI color applied - the biome's name prints in the codeblock's default color. */
export function getBiomeAnsiColor(biome: string): string {
    return registry.get(biome)?.ansiColor ?? "";
}

export interface AnsiColorOption {
    slug: string;
    name: string;
    code: number;
}

/** The 8 text colors Discord's `ansi` codeblock renders (SGR 30-37), named as Discord shows them. */
export const ANSI_TEXT_COLORS: readonly AnsiColorOption[] = [
    { slug: "gray", name: "Gray", code: 30 },
    { slug: "red", name: "Red", code: 31 },
    { slug: "green", name: "Green", code: 32 },
    { slug: "yellow", name: "Yellow", code: 33 },
    { slug: "blue", name: "Blue", code: 34 },
    { slug: "pink", name: "Pink", code: 35 },
    { slug: "cyan", name: "Cyan", code: 36 },
    { slug: "white", name: "White", code: 37 },
];

/** The 8 background colors Discord's `ansi` codeblock renders (SGR 40-47), named as Discord shows them. */
export const ANSI_BACKGROUND_COLORS: readonly AnsiColorOption[] = [
    { slug: "dark-blue", name: "Dark Blue", code: 40 },
    { slug: "orange", name: "Orange", code: 41 },
    { slug: "marble-blue", name: "Marble Blue", code: 42 },
    { slug: "turquoise", name: "Grayish Turquoise", code: 43 },
    { slug: "gray", name: "Gray", code: 44 },
    { slug: "indigo", name: "Indigo", code: 45 },
    { slug: "light-gray", name: "Light Gray", code: 46 },
    { slug: "white", name: "White", code: 47 },
];

/** A biome name's ANSI styling, split into the parts Discord renders. `null` = that part unset. */
export interface AnsiStyle {
    bold: boolean;
    /** SGR 30-37. */
    text: number | null;
    /** SGR 40-47. */
    background: number | null;
}

const ANSI_ESCAPE = "\u001b[";

/** `{ bold, text: 31, background: 40 }` -> `"\u001b[1;31;40m"`; nothing set -> `""` (no color). */
export function buildAnsiCode(style: AnsiStyle): string {
    const parts = [style.bold ? 1 : null, style.text, style.background].filter((p) => p !== null);
    return parts.length > 0 ? `${ANSI_ESCAPE}${parts.join(";")}m` : "";
}

/** Reverse of `buildAnsiCode` - SGR parts Discord doesn't render are ignored. */
export function parseAnsiCode(code: string | undefined): AnsiStyle {
    const style: AnsiStyle = { bold: false, text: null, background: null };
    if (!code?.startsWith(ANSI_ESCAPE) || !code.endsWith("m")) return style;
    for (const part of code.slice(ANSI_ESCAPE.length, -1).split(";").map(Number)) {
        if (part === 1) style.bold = true;
        else if (part >= 30 && part <= 37) style.text = part;
        else if (part >= 40 && part <= 47) style.background = part;
    }
    return style;
}

/** e.g. "Bold Red on Dark Blue", or "None". */
export function describeAnsiColor(code: string | undefined): string {
    const style = parseAnsiCode(code);
    const text = ANSI_TEXT_COLORS.find((c) => c.code === style.text)?.name;
    const background = ANSI_BACKGROUND_COLORS.find((c) => c.code === style.background)?.name;
    const words = [
        style.bold ? "Bold" : null,
        text ?? (style.bold || background ? "Default" : null),
        background ? `on ${background}` : null,
    ];
    return words.filter((w) => w !== null).join(" ") || "None";
}
