import {
    ALL_BIOME_CATEGORIES,
    ANSI_BACKGROUND_COLORS,
    ANSI_TEXT_COLORS,
    type AnsiColorOption,
    type BiomeEntry,
    type BiomeMeta,
    buildAnsiCode,
    getBiomeMeta,
    normalizeBiomeName,
    parseAnsiCode,
} from "../constants/biomes.constants";
import { insertBiome, loadBiomeRegistry, setBiomeEnabled, updateBiome } from "../repository/biomes.repository";
import { type BiomeCategory, BiomeHuntError } from "../types";

/** Typed into `flavor_text`/`icon_url` on `/bh-owner biome edit` to remove the value; also the "no color" choice of `ansi_text`/`ansi_background`. */
export const CLEAR_VALUE = "none";

const MAX_KEY_LENGTH = 40;
const MAX_LABEL_LENGTH = 60;

export interface BiomeAdminDeps {
    insertBiome: (key: string, meta: BiomeMeta) => Promise<boolean>;
    updateBiome: (key: string, meta: BiomeMeta) => Promise<void>;
    setBiomeEnabled: (key: string, enabled: boolean) => Promise<void>;
    /** Re-reads the table into the in-memory registry, so the change applies right away. */
    reloadRegistry: () => Promise<void>;
}

export function defaultBiomeAdminDeps(): BiomeAdminDeps {
    return { insertBiome, updateBiome, setBiomeEnabled, reloadRegistry: loadBiomeRegistry };
}

/** Exactly 6 hex digits, no `#` (e.g. `ff8c00`) -> 0xff8c00. */
export function parseHexColor(raw: string): number {
    const hex = raw.trim();
    if (!/^[0-9a-f]{6}$/i.test(hex))
        throw new BiomeHuntError(`\`${raw}\` is not a valid color - use 6 hex digits without \`#\`, like \`ff8c00\`.`);
    return Number.parseInt(hex, 16);
}

/** Same form `parseHexColor` takes - 6 hex digits, no `#`. */
export function formatHexColor(color: number): string {
    return color.toString(16).padStart(6, "0").toUpperCase();
}

export function parseCategory(raw: string): BiomeCategory {
    const category = raw.trim().toLowerCase() as BiomeCategory;
    if (!ALL_BIOME_CATEGORIES.includes(category)) throw new BiomeHuntError(`Category must be one of: ${ALL_BIOME_CATEGORIES.join(", ")}.`);
    return category;
}

export function parseIconUrl(raw: string): string {
    const url = raw.trim();
    if (!/^https:\/\/\S+$/i.test(url)) throw new BiomeHuntError("The icon must be an `https://` image URL.");
    return url;
}

/** The ANSI parts given on add/edit. Each one: `null` = not given (edit keeps the current one). */
export interface AnsiInput {
    /** A text color slug (see `ANSI_TEXT_COLORS`), or `CLEAR_VALUE` for none. */
    text: string | null;
    /** A background color slug (see `ANSI_BACKGROUND_COLORS`), or `CLEAR_VALUE` for none. */
    background: string | null;
    bold: boolean | null;
}

function parseAnsiColor(slug: string, options: readonly AnsiColorOption[], what: string): number | null {
    if (isClear(slug)) return null;
    const option = options.find((o) => o.slug === slug.trim().toLowerCase());
    if (!option) throw new BiomeHuntError(`Unknown ANSI ${what} color \`${slug}\` - pick one from the list.`);
    return option.code;
}

/** Builds the stored ANSI code from the given parts over the current code's - `undefined` = no color. */
export function applyAnsiInput(current: string | undefined, input: AnsiInput): string | undefined {
    const style = parseAnsiCode(current);
    if (input.text !== null) style.text = parseAnsiColor(input.text, ANSI_TEXT_COLORS, "text");
    if (input.background !== null) style.background = parseAnsiColor(input.background, ANSI_BACKGROUND_COLORS, "background");
    if (input.bold !== null) style.bold = input.bold;
    return buildAnsiCode(style) || undefined;
}

export function parseFlavorText(raw: string): string {
    const text = raw.trim();
    if (text.includes("\n")) throw new BiomeHuntError("The flavor text must be a single line.");
    return text;
}

/** The biome key a detection name maps to - the same normalization the macro parsers match with. */
export function biomeKeyFor(detectionName: string): string {
    const key = normalizeBiomeName(detectionName);
    if (!key)
        throw new BiomeHuntError(
            `\`${detectionName}\` can't be matched against macro text - a detection name needs letters or digits (A-Z, 0-9). Pass \`detection_name\` with the name as macros write it.`,
        );
    if (key.length > MAX_KEY_LENGTH) throw new BiomeHuntError(`A detection name can have at most ${MAX_KEY_LENGTH} letters/digits.`);
    return key;
}

export function parseLabel(raw: string): string {
    const label = raw.trim();
    if (!label) throw new BiomeHuntError("The name can't be empty.");
    if (label.length > MAX_LABEL_LENGTH) throw new BiomeHuntError(`The name can have at most ${MAX_LABEL_LENGTH} characters.`);
    return label;
}

export interface AddBiomeInput {
    /** Display name - any text. */
    name: string;
    /** The name as macros report it; `null` = the display name. */
    detectionName: string | null;
    category: string;
    color: string;
    flavorText: string | null;
    iconUrl: string | null;
    ansi: AnsiInput;
}

/** Adds a new, enabled biome. Its key is the detection name normalized (e.g. "Blood Rain" -> `BLOODRAIN`). */
export async function addBiome(input: AddBiomeInput, deps: BiomeAdminDeps = defaultBiomeAdminDeps()): Promise<BiomeEntry> {
    const label = parseLabel(input.name);
    const key = biomeKeyFor(input.detectionName ?? label);
    const meta: BiomeMeta = {
        label,
        category: parseCategory(input.category),
        color: parseHexColor(input.color),
        flavorText: input.flavorText ? parseFlavorText(input.flavorText) : undefined,
        iconUrl: input.iconUrl ? parseIconUrl(input.iconUrl) : undefined,
        ansiColor: applyAnsiInput(undefined, input.ansi),
    };

    const existing = getBiomeMeta(key);
    if (existing) throw new BiomeHuntError(`\`${key}\` already exists (${existing.label}) - use \`/bh-owner biome edit\` to change it.`);
    if (!(await deps.insertBiome(key, meta)))
        throw new BiomeHuntError(`\`${key}\` already exists - use \`/bh-owner biome edit\` to change it.`);
    await deps.reloadRegistry();
    return { ...meta, key, enabled: true };
}

export interface EditBiomeInput {
    biome: string;
    label: string | null;
    category: string | null;
    color: string | null;
    /** `CLEAR_VALUE` removes it. */
    flavorText: string | null;
    /** `CLEAR_VALUE` removes it. */
    iconUrl: string | null;
    ansi: AnsiInput;
}

function requireBiome(raw: string): BiomeEntry {
    const entry = getBiomeMeta(normalizeBiomeName(raw));
    if (!entry) throw new BiomeHuntError(`\`${raw}\` is not a registered biome - see \`/bh-owner biome list\`.`);
    return entry;
}

const isClear = (raw: string) => raw.trim().toLowerCase() === CLEAR_VALUE;

/** Changes only the fields given; the key (detection name) never changes - old finds are stored under it. */
export async function editBiome(input: EditBiomeInput, deps: BiomeAdminDeps = defaultBiomeAdminDeps()): Promise<BiomeEntry> {
    const current = requireBiome(input.biome);
    const { ansi } = input;
    const given = [input.label, input.category, input.color, input.flavorText, input.iconUrl, ansi.text, ansi.background, ansi.bold];
    if (given.every((v) => v === null)) throw new BiomeHuntError("Nothing to change - pass at least one field.");

    const next: BiomeEntry = { ...current };
    if (input.label !== null) next.label = parseLabel(input.label);
    if (input.category !== null) next.category = parseCategory(input.category);
    if (input.color !== null) next.color = parseHexColor(input.color);
    if (input.flavorText !== null) next.flavorText = isClear(input.flavorText) ? undefined : parseFlavorText(input.flavorText);
    if (input.iconUrl !== null) next.iconUrl = isClear(input.iconUrl) ? undefined : parseIconUrl(input.iconUrl);
    next.ansiColor = applyAnsiInput(current.ansiColor, ansi);

    await deps.updateBiome(next.key, next);
    await deps.reloadRegistry();
    return next;
}

/** Turns recognition and pickers on/off for a biome. Old finds keep displaying either way. */
export async function setBiomeActive(raw: string, enabled: boolean, deps: BiomeAdminDeps = defaultBiomeAdminDeps()): Promise<BiomeEntry> {
    const current = requireBiome(raw);
    if (current.enabled === enabled) throw new BiomeHuntError(`${current.label} is already ${enabled ? "enabled" : "disabled"}.`);
    await deps.setBiomeEnabled(current.key, enabled);
    await deps.reloadRegistry();
    return { ...current, enabled };
}
