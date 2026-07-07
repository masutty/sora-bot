import { Logger } from "@/utils/logging";
import { BIOME_META } from "../types";
import { MacroParser, type BiomeExtraction, type EmbedLike } from "./types";

const logger = new Logger("biomehunt.macroParsers");

/**
 * Matches "Biome Started/Ended - NAME" (or "NAME2 NAME - Biome Started/Ended" if a subclass
 * reorders it). `words` captures 1-2 alphanumeric tokens - enough for any known 2-word biome
 * name - bounded so it can't run on into unrelated trailing text (e.g. a "Join Server" link
 * on the same line).
 */
const DEFAULT_BIOME_REGEX =
    /Biome\s+(?<event>Started|Ended)\b[^A-Za-z0-9]*(?<words>[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+)?)/i;

const DEFAULT_THUMBNAIL_REGEX =
    /\/([A-Z_]+)\.png$/i;

const DEFAULT_ROBLOX_LINK_REGEX =
    /https?:\/\/(?:www\.)?roblox\.com\/[^\s)\]"'<>]+/i;

/** Single source of truth for recognized biomes lives in `BIOME_META` (types.ts). */
const VALID_BIOMES = new Set(Object.keys(BIOME_META));

/** Some macros report multi-word biome names with a literal space (e.g. "SAND STORM") - normalize to one space-less token before matching against VALID_BIOMES. */
function normalizeBiomeName(raw: string): string {
    return raw.trim().toUpperCase().replace(/[\s_]+/g, "");
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~`>#]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export interface MacroParserRegexes {
    /**
     * Must expose two named groups: `event` (Started|Ended) and `words` (1-2 alphanumeric
     * tokens making up the biome name). The relative order of `words` and "Biome
     * Started/Ended" in the string is up to the macro's format - e.g. JJaram reports
     * "NAME Biome Started/Ended" instead of the common "Biome Started/Ended - NAME".
     */
    biomeRegex?: RegExp;
    thumbnailRegex?: RegExp;
    robloxLinkRegex?: RegExp;
}

/**
 * The behavior verified against real sample payloads at implementation time: the
 * `Biome Started|Ended - NAME` string appears in either the title or the description
 * (position varies by macro), and the private server link is either plain text in the
 * embed or a Link button. Most macros follow this, so they extend this class unmodified -
 * a macro with a different format (e.g. a reordered biome pattern) passes its own patterns
 * to the constructor instead, or overrides `extractBiome`/`extractServerLink` entirely if
 * the format differs more fundamentally.
 */
export class DefaultMacroParser extends MacroParser {
    protected readonly biomeRegex: RegExp;
    protected readonly thumbnailRegex: RegExp;
    protected readonly robloxLinkRegex: RegExp;

    constructor(id: string, regexes?: MacroParserRegexes) {
        super(id);
        this.biomeRegex = regexes?.biomeRegex ?? DEFAULT_BIOME_REGEX;
        this.thumbnailRegex = regexes?.thumbnailRegex ?? DEFAULT_THUMBNAIL_REGEX;
        this.robloxLinkRegex = regexes?.robloxLinkRegex ?? DEFAULT_ROBLOX_LINK_REGEX;
    }

    extractBiome(embed: EmbedLike): BiomeExtraction {
        const candidates = [
            embed.title,
            embed.description,
            ...(embed.fields?.map((f) => f.value) ?? []),
        ];

        logger.debug(`Parsing embed (${candidates.length} candidate(s))`);

        for (const text of candidates) {
            if (!text) continue;

            logger.debug(`Candidate: ${JSON.stringify(text)}`);

            const cleaned = stripMarkdown(text);
            logger.debug(`Cleaned: ${JSON.stringify(cleaned)}`);

            const match = cleaned.match(this.biomeRegex);
            if (!match?.groups) {
                logger.debug("No regex match.");
                continue;
            }

            logger.debug(`Regex matched: ${JSON.stringify(match)}`);

            const eventType: "started" | "ended" = match.groups.event.toLowerCase() === "started" ? "started" : "ended";
            const words = match.groups.words.trim().split(/\s+/);

            // Try the 2-word combo first (e.g. "SAND STORM" -> SANDSTORM), then fall back to
            // just the first word (e.g. "SINGULARITY" followed by unrelated trailing text).
            if (words.length > 1) {
                const combined = normalizeBiomeName(words.join(" "));
                logger.debug(`Trying combined biome "${combined}" (${eventType})`);

                if (VALID_BIOMES.has(combined)) {
                    logger.debug(`Matched biome "${combined}"`);
                    return { biome: combined, eventType };
                }
            }

            const single = normalizeBiomeName(words[0]);
            logger.debug(`Trying single biome "${single}" (${eventType})`);

            if (VALID_BIOMES.has(single)) {
                logger.debug(`Matched biome "${single}"`);
                return { biome: single, eventType };
            }

            logger.warn(`Unknown biome: ${normalizeBiomeName(words.join(" "))}`);
            return { biome: null, eventType: null };
        }

        // fallback → thumbnail
        logger.debug("Falling back to thumbnail.");

        const thumb = embed.thumbnail?.url;
        if (thumb) {
            logger.debug(`Thumbnail URL: ${thumb}`);

            const match = thumb.match(this.thumbnailRegex);
            if (match) {
                const biome = normalizeBiomeName(match[1]);
                logger.debug(`Thumbnail resolved biome "${biome}"`);

                if (VALID_BIOMES.has(biome)) {
                    logger.debug(`Matched biome "${biome}" from thumbnail`);
                    return { biome, eventType: null };
                }

                logger.warn(`Unknown biome "${biome}" from thumbnail`);
            } else {
                logger.debug("Thumbnail regex did not match.");
            }
        } else {
            logger.debug("No thumbnail present.");
        }

        logger.debug("Failed to extract biome.");
        return { biome: null, eventType: null };
    }

    /**
     * Most macros put the Roblox private server join link as plain text somewhere in the
     * embed (title/description/a field) - searched on the RAW text, not the markdown-stripped
     * version, since stripMarkdown collapses `[label](url)` down to just `label`. Some macros
     * (e.g. Multiscope) instead attach it as a separate Link button, checked as a fallback.
     */
    extractServerLink(embed: EmbedLike, components?: ReadonlyArray<unknown>): string | null {
        const candidates = [embed.title, embed.description, ...(embed.fields?.map((f) => f.value) ?? [])];

        for (const text of candidates) {
            if (!text) continue;
            const match = text.match(this.robloxLinkRegex);
            if (match) return match[0];
        }

        for (const row of components ?? []) {
            const buttons = (row as { components?: ReadonlyArray<{ url?: string | null }> })?.components ?? [];
            for (const c of buttons) {
                const match = c.url?.match(this.robloxLinkRegex);
                if (match) return match[0];
            }
        }

        return null;
    }
}
