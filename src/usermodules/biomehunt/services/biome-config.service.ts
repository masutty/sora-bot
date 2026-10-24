import { ANSI_BACKGROUND_COLORS, ANSI_TEXT_COLORS, type BiomeEntry, getAllBiomes, parseAnsiCode } from "../constants/biomes.constants";
import { loadBiomeRegistry, saveAllBiomes } from "../repository/biomes.repository";
import { BiomeHuntError } from "../types";
import {
    applyAnsiInput,
    biomeKeyFor,
    CLEAR_VALUE,
    formatHexColor,
    parseBadgeEmoji,
    parseCategory,
    parseDuration,
    parseFlavorText,
    parseHexColor,
    parseIconUrl,
    parseLabel,
} from "./biome-admin.service";

/** Identifies a biome config file, so `import` refuses any other JSON. */
export const BIOME_CONFIG_FORMAT = "sora-bot.biomes";
export const BIOME_CONFIG_VERSION = 1;

/** One biome in the file - the same fields `/owner biome add` takes, in the same forms. */
export interface BiomeConfigEntry {
    detectionName: string;
    label: string;
    category: string;
    /** 6 hex digits, no `#`. */
    color: string;
    flavorText: string | null;
    iconUrl: string | null;
    /** Slugs of `ANSI_TEXT_COLORS` / `ANSI_BACKGROUND_COLORS` - `null` = none. */
    ansi: { text: string | null; background: string | null; bold: boolean };
    /** Fixed length in seconds (see `BiomeMeta.durationS`) - `null` = not timed. Optional in the file. */
    durationSeconds?: number | null;
    /** Whether finding it gives a profile badge. Optional in the file - absent = no badge. */
    hasBadge?: boolean;
    /** The badge's emoji - `null` = the default one. Optional in the file. */
    badgeEmoji?: string | null;
    /** Whether its finds count in the macro channel name. Optional in the file - absent = no. */
    showInChannelName?: boolean;
    enabled: boolean;
}

/**
 * `/owner biome export`'s file - every registered biome (disabled ones included) in picker
 * order, so `import` on another bot (dev -> prod or back) can reproduce the same registry.
 */
export interface BiomeConfigFile {
    format: typeof BIOME_CONFIG_FORMAT;
    version: typeof BIOME_CONFIG_VERSION;
    exportedAt: string;
    /** The exporting bot's tag - tells a dev export from a prod one. */
    exportedBy: string | null;
    biomes: BiomeConfigEntry[];
}

function toConfigEntry(e: BiomeEntry): BiomeConfigEntry {
    const style = parseAnsiCode(e.ansiColor);
    return {
        detectionName: e.key,
        label: e.label,
        category: e.category,
        color: formatHexColor(e.color),
        flavorText: e.flavorText || null,
        iconUrl: e.iconUrl || null,
        ansi: {
            text: ANSI_TEXT_COLORS.find((c) => c.code === style.text)?.slug ?? null,
            background: ANSI_BACKGROUND_COLORS.find((c) => c.code === style.background)?.slug ?? null,
            bold: style.bold,
        },
        durationSeconds: e.durationS ?? null,
        hasBadge: e.hasBadge === true,
        badgeEmoji: e.badgeEmoji || null,
        showInChannelName: e.showInChannelName === true,
        enabled: e.enabled,
    };
}

export function buildBiomeConfig(entries: BiomeEntry[], exportedBy: string | null, now = new Date()): BiomeConfigFile {
    return {
        format: BIOME_CONFIG_FORMAT,
        version: BIOME_CONFIG_VERSION,
        exportedAt: now.toISOString(),
        exportedBy,
        biomes: entries.map(toConfigEntry),
    };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown) => (v === null || v === undefined ? null : String(v));

function parseDurationSeconds(raw: unknown): number | undefined {
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)
        throw new BiomeHuntError("`durationSeconds` must be a whole number of seconds");
    return parseDuration(`${raw}s`);
}

function fromConfigEntry(raw: unknown): BiomeEntry {
    if (!isObject(raw)) throw new BiomeHuntError("not an object");
    const ansi = isObject(raw.ansi) ? raw.ansi : {};
    if (typeof raw.detectionName !== "string") throw new BiomeHuntError("`detectionName` is missing");
    if (typeof raw.label !== "string") throw new BiomeHuntError("`label` is missing");
    const flavorText = optionalString(raw.flavorText);
    const iconUrl = optionalString(raw.iconUrl);
    return {
        key: biomeKeyFor(raw.detectionName),
        label: parseLabel(raw.label),
        category: parseCategory(String(raw.category)),
        color: parseHexColor(String(raw.color)),
        flavorText: flavorText ? parseFlavorText(flavorText) : undefined,
        iconUrl: iconUrl ? parseIconUrl(iconUrl) : undefined,
        ansiColor: applyAnsiInput(undefined, {
            text: optionalString(ansi.text) ?? CLEAR_VALUE,
            background: optionalString(ansi.background) ?? CLEAR_VALUE,
            bold: ansi.bold === true,
        }),
        durationS: parseDurationSeconds(raw.durationSeconds),
        hasBadge: raw.hasBadge === true,
        badgeEmoji: optionalString(raw.badgeEmoji) ? parseBadgeEmoji(String(raw.badgeEmoji)) : undefined,
        showInChannelName: raw.showInChannelName === true,
        enabled: raw.enabled !== false,
    };
}

/**
 * Reads and fully validates an exported file - every biome is checked with the same rules as
 * `/owner biome add`. Any problem refuses the WHOLE file, listing every bad biome, so a partial
 * import never happens.
 */
export function parseBiomeConfig(text: string): BiomeEntry[] {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new BiomeHuntError("The file isn't valid JSON.");
    }
    if (!isObject(json) || json.format !== BIOME_CONFIG_FORMAT)
        throw new BiomeHuntError(`The file isn't a biome config (expected \`"format": "${BIOME_CONFIG_FORMAT}"\`).`);
    if (json.version !== BIOME_CONFIG_VERSION)
        throw new BiomeHuntError(
            `Unsupported biome config version \`${String(json.version)}\` - this bot reads version ${BIOME_CONFIG_VERSION}.`,
        );
    if (!Array.isArray(json.biomes) || json.biomes.length === 0) throw new BiomeHuntError("The file has no biomes.");

    const entries: BiomeEntry[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    json.biomes.forEach((raw, i) => {
        const name = isObject(raw) && typeof raw.detectionName === "string" ? raw.detectionName : `#${i + 1}`;
        try {
            const entry = fromConfigEntry(raw);
            if (seen.has(entry.key)) throw new BiomeHuntError("appears twice");
            seen.add(entry.key);
            entries.push(entry);
        } catch (err) {
            if (!(err instanceof BiomeHuntError)) throw err;
            errors.push(`- \`${name}\`: ${err.message}`);
        }
    });
    if (errors.length > 0) throw new BiomeHuntError(`Nothing was imported - fix these biomes first:\n${errors.slice(0, 15).join("\n")}`);
    return entries;
}

const COMPARED_FIELDS = [
    "label",
    "category",
    "color",
    "flavorText",
    "iconUrl",
    "ansiColor",
    "durationS",
    "hasBadge",
    "badgeEmoji",
    "showInChannelName",
    "enabled",
] as const;

/** `""` and `undefined` both mean "not set" (e.g. a seeded empty icon URL vs. a missing one). */
const unset = <T>(v: T) => (v === "" ? undefined : v);

/** A field's value for comparing - an unset `hasBadge`/`showInChannelName` is the same as `false`. */
const comparable = (field: (typeof COMPARED_FIELDS)[number], v: unknown) =>
    field === "hasBadge" || field === "showInChannelName" ? v === true : unset(v);

export interface BiomeImportPlan {
    added: string[];
    /** Detection name -> the fields that change. */
    updated: Array<{ key: string; fields: string[] }>;
    /** Only in mirror mode: biomes missing from the file that get disabled. */
    disabled: string[];
    unchanged: number;
    /** The registry after the import, in its new order: the file's biomes first, then the rest. */
    result: BiomeEntry[];
}

/**
 * What importing `incoming` over `current` changes. The file's biomes are added or overwritten and
 * take the file's order; biomes missing from it are kept as they are, or disabled with `mirror` -
 * never deleted, since old finds are stored under their key.
 */
export function planBiomeImport(current: BiomeEntry[], incoming: BiomeEntry[], mirror: boolean): BiomeImportPlan {
    const byKey = new Map(current.map((e) => [e.key, e]));
    const incomingKeys = new Set(incoming.map((e) => e.key));
    const plan: BiomeImportPlan = { added: [], updated: [], disabled: [], unchanged: 0, result: [...incoming] };

    for (const e of incoming) {
        const existing = byKey.get(e.key);
        if (!existing) {
            plan.added.push(e.key);
            continue;
        }
        const fields = COMPARED_FIELDS.filter((f) => comparable(f, existing[f]) !== comparable(f, e[f]));
        if (fields.length > 0) plan.updated.push({ key: e.key, fields: [...fields] });
        else plan.unchanged++;
    }
    for (const e of current) {
        if (incomingKeys.has(e.key)) continue;
        if (mirror && e.enabled) {
            plan.disabled.push(e.key);
            plan.result.push({ ...e, enabled: false });
        } else {
            plan.result.push(e);
            plan.unchanged++;
        }
    }
    return plan;
}

export interface BiomeConfigDeps {
    saveAllBiomes: (entries: BiomeEntry[]) => Promise<void>;
    reloadRegistry: () => Promise<void>;
}

export function defaultBiomeConfigDeps(): BiomeConfigDeps {
    return { saveAllBiomes, reloadRegistry: loadBiomeRegistry };
}

/** Writes a plan's resulting registry in one transaction, then reloads it so it applies right away. */
export async function applyBiomeImport(plan: BiomeImportPlan, deps: BiomeConfigDeps = defaultBiomeConfigDeps()): Promise<void> {
    await deps.saveAllBiomes(plan.result);
    await deps.reloadRegistry();
}

/** The current registry as an export file. */
export function exportCurrentBiomes(exportedBy: string | null): BiomeConfigFile {
    return buildBiomeConfig(getAllBiomes(), exportedBy);
}
