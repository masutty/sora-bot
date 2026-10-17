import { Logger } from "@/utils/logging";
import { isKnownBiome, normalizeBiomeName } from "../constants/biomes.constants";
import { type BiomeExtraction, type EmbedLike, MacroParser } from "./types";

const logger = new Logger("biomehunt.macro-parsers");

/** Longest biome name, in words, read from macro text - a detection name with more words can't be matched there. */
export const MAX_BIOME_NAME_WORDS = 5;

/**
 * One word of a biome name: letters/digits, with `'`, `’` or `-` allowed between them - so
 * "NULL'S" stays one word (key part `NULLS`) instead of being cut to "NULL", which would match the
 * Null biome.
 */
const BIOME_WORD = "[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*";

/**
 * The `words` group every biome regex captures: 1 to `MAX_BIOME_NAME_WORDS` words. It may run on
 * into unrelated text around the name (e.g. a "Join Server" link on the same line) -
 * `findBiomeInWords` picks the biome out of it.
 */
export const BIOME_WORDS_PATTERN = String.raw`(?<words>${BIOME_WORD}(?:\s+${BIOME_WORD}){0,${MAX_BIOME_NAME_WORDS - 1}})`;

/** Matches "Biome Started/Ended - NAME" (or "NAME Biome Started/Ended" if a subclass reorders it). */
const DEFAULT_BIOME_REGEX = new RegExp(String.raw`Biome\s+(?<event>Started|Ended)\b[^A-Za-z0-9]*` + BIOME_WORDS_PATTERN, "i");

const DEFAULT_THUMBNAIL_REGEX = /\/([A-Z_]+)\.png$/i;

const DEFAULT_ROBLOX_LINK_REGEX = /https?:\/\/(?:www\.)?roblox\.com\/[^\s)\]"'<>]+/i;

/**
 * The longest known biome the words start with - or end with, when the name comes before the
 * "Biome Started" anchor (J.Jaram) - so a 3+ word name like "The Radiant Forest" matches and text
 * on the far side of it doesn't get in the way. Anchored on purpose: a word in the middle never
 * matches alone, so "The Hell Gate" isn't read as Hell.
 */
function findBiomeInWords(words: string[], fromEnd: boolean): string | null {
    for (let length = words.length; length >= 1; length--) {
        const span = fromEnd ? words.slice(words.length - length) : words.slice(0, length);
        const candidate = normalizeBiomeName(span.join(" "));
        if (isKnownBiome(candidate)) return candidate;
    }
    return null;
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
     * Must expose two named groups: `event` (Started|Ended) and `words` (the alphanumeric
     * tokens around the biome name - build it from `BIOME_WORDS_PATTERN`). The relative order of `words` and "Biome
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
        const candidates = [embed.title, embed.description, ...(embed.fields?.map((f) => f.value) ?? [])];

        logger.verbose(`Parsing embed (${candidates.length} candidate(s))`);

        for (const text of candidates) {
            if (!text) continue;

            logger.verbose(`Candidate: ${JSON.stringify(text)}`);

            const cleaned = stripMarkdown(text);
            logger.verbose(`Cleaned: ${JSON.stringify(cleaned)}`);

            const match = cleaned.match(this.biomeRegex);
            if (!match?.groups) {
                logger.verbose("No regex match.");
                continue;
            }

            logger.verbose(`Regex matched: ${JSON.stringify(match)}`);

            const eventType: "started" | "ended" = match.groups.event.toLowerCase() === "started" ? "started" : "ended";
            const words = match.groups.words.trim().split(/\s+/);

            // The name sits right after the anchor ("Biome Started - NAME"), unless the regex puts it first ("NAME Biome Started").
            const nameBeforeAnchor = match[0].startsWith(match.groups.words);
            const biome = findBiomeInWords(words, nameBeforeAnchor);
            if (biome) {
                logger.verbose(`Matched biome "${biome}" (${eventType})`);
                return { biome, eventType };
            }

            logger.warn(`Unknown biome: ${normalizeBiomeName(words.join(" "))}`);
            return { biome: null, eventType: null };
        }

        // fallback → thumbnail
        logger.verbose("Falling back to thumbnail.");

        const thumb = embed.thumbnail?.url;
        if (thumb) {
            logger.verbose(`Thumbnail URL: ${thumb}`);

            const match = thumb.match(this.thumbnailRegex);
            if (match) {
                const biome = normalizeBiomeName(match[1]);
                logger.verbose(`Thumbnail resolved biome "${biome}"`);

                if (isKnownBiome(biome)) {
                    logger.verbose(`Matched biome "${biome}" from thumbnail`);
                    return { biome, eventType: null };
                }

                logger.warn(`Unknown biome "${biome}" from thumbnail`);
            } else {
                logger.verbose("Thumbnail regex did not match.");
            }
        } else {
            logger.verbose("No thumbnail present.");
        }

        logger.verbose("Failed to extract biome.");
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
