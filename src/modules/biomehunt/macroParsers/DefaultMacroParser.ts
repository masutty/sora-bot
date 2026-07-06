import { Logger } from "@/utils/logging";
import { BIOME_META } from "../types";
import { MacroParser, type BiomeExtraction, type EmbedLike } from "./types";

const logger = new Logger("biomehunt.macroParsers");

/** Captures up to 2 words after "Biome Started/Ended" - enough for any known 2-word biome name, bounded so it can't run on into unrelated trailing text (e.g. a "Join Server" link on the same line). */
const BIOME_PATTERN =
    /Biome\s+(Started|Ended)\b[^A-Za-z0-9]*([A-Za-z0-9_]+)(?:\s+([A-Za-z0-9_]+))?/i;

const THUMBNAIL_PATTERN =
    /\/([A-Z_]+)\.png$/i;

const ROBLOX_LINK_PATTERN =
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

/**
 * The behavior verified against real sample payloads at implementation time: the
 * `Biome Started|Ended - NAME` string appears in either the title or the description
 * (position varies by macro), and the private server link is either plain text in the
 * embed or a Link button. Every macro currently follows this, so they all extend this
 * class unmodified - override a specific macro's class if its format is later found to differ.
 */
export class DefaultMacroParser extends MacroParser {
    extractBiome(embed: EmbedLike): BiomeExtraction {
        const candidates = [
            embed.title,
            embed.description,
            ...(embed.fields?.map((f) => f.value) ?? []),
        ];

        for (const text of candidates) {
            if (!text) continue;

            const cleaned = stripMarkdown(text);
            const match = cleaned.match(BIOME_PATTERN);
            if (!match) continue;

            const eventType: "started" | "ended" = match[1].toLowerCase() === "started" ? "started" : "ended";
            const [word1, word2] = [match[2], match[3]];

            // Try the 2-word combo first (e.g. "SAND STORM" -> SANDSTORM), then fall back to
            // just the first word (e.g. "SINGULARITY" followed by unrelated trailing text).
            if (word2) {
                const combined = normalizeBiomeName(`${word1} ${word2}`);
                if (VALID_BIOMES.has(combined)) return { biome: combined, eventType };
            }

            const single = normalizeBiomeName(word1);
            if (VALID_BIOMES.has(single)) return { biome: single, eventType };

            logger.warn(`Unknown biome: ${normalizeBiomeName(word2 ? `${word1} ${word2}` : word1)}`);
            return { biome: null, eventType: null };
        }

        // fallback → thumbnail
        const thumb = embed.thumbnail?.url;
        if (thumb) {
            const match = thumb.match(THUMBNAIL_PATTERN);
            if (match) {
                const biome = normalizeBiomeName(match[1]);
                if (VALID_BIOMES.has(biome)) return { biome, eventType: null };
            }
        }

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
            const match = text.match(ROBLOX_LINK_PATTERN);
            if (match) return match[0];
        }

        for (const row of components ?? []) {
            const buttons = (row as { components?: ReadonlyArray<{ url?: string | null }> })?.components ?? [];
            for (const c of buttons) {
                const match = c.url?.match(ROBLOX_LINK_PATTERN);
                if (match) return match[0];
            }
        }

        return null;
    }
}
