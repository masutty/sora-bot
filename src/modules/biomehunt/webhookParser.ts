import { Logger } from "@/utils/logging";
import type { ParsedEvent } from "./types";

const logger = new Logger("biomehunt.webhookParser");

export interface WebhookMessageLike {
    webhookId: string | null;

    embeds: ReadonlyArray<{
        title?: string | null;
        description?: string | null;
        footer?: {
            text?: string | null;
        } | null;
        timestamp?: string | null;

        thumbnail?: {
            url?: string | null;
        } | null;

        fields?: ReadonlyArray<{
            name?: string | null;
            value?: string | null;
        }>;
    }>;
}

type MacroType =
    | "coteab"
    | "multiscope"
    | "eggsol"
    | "maxstellar"
    | "droidscope"
    | "unknown";

const BIOME_PATTERN =
    /Biome\s+(Started|Ended)\b[^A-Za-z0-9]*([A-Za-z0-9_]+)/i;

const THUMBNAIL_PATTERN =
    /\/([A-Z_]+)\.png$/i;

const VALID_BIOMES = new Set([
    "WINDY",
    "HELL",
    "SNOWY",
    "RAINY",
    "NULL"
]);

function stripMarkdown(text: string): string {
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_~`>#]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function detectMacro(footer?: string | null): MacroType {
    if (!footer) return "unknown";

    const f = footer.toLowerCase();

    if (f.includes("coteab")) return "coteab";
    if (f.includes("multiscope")) return "multiscope";
    if (f.includes("eggsol")) return "eggsol";
    if (f.includes("maxstellar")) return "maxstellar";
    if (f.includes("droidscope")) return "droidscope";

    return "unknown";
}

function extractBiome(embed: WebhookMessageLike["embeds"][0]): { biome: string | null; eventType: "started" | "ended" | null } {
    // try title + description first
    const candidates = [
        embed.title,
        embed.description,
        ...(embed.fields?.map(f => f.value) ?? [])
    ];

    for (const text of candidates) {
        if (!text) continue;

        const cleaned = stripMarkdown(text);
        const match = cleaned.match(BIOME_PATTERN);

        if (match) {
            const biome = match[2].toUpperCase();

            if (!VALID_BIOMES.has(biome)) {
                logger.warn(`Unknown biome: ${biome}`);
                return { biome: null, eventType: null };
            }

            return {
                biome,
                eventType:
                    match[1].toLowerCase() === "started"
                        ? "started"
                        : "ended"
            };
        }
    }

    // fallback → thumbnail
    const thumb = embed.thumbnail?.url;

    if (thumb) {
        const match = thumb.match(THUMBNAIL_PATTERN);

        if (match) {
            const biome = match[1].toUpperCase();

            if (VALID_BIOMES.has(biome)) {
                return {
                    biome,
                    eventType: null
                };
            }
        }
    }

    return {
        biome: null,
        eventType: null
    };
}

export function parseEvent(message: WebhookMessageLike): ParsedEvent | null {
    const embed = message.embeds[0];
    if (!embed) return null;

    const macroType = detectMacro(embed.footer?.text);
    if (macroType === "unknown") {
        logger.warn(`Webhook ${message.webhookId} has unknown macro type: ${embed.footer?.text}`);
    }

    // event type is "started"|"ended"
    const { biome, eventType } = extractBiome(embed);

    if (!biome) return null;

    return {
        biome,
        macroType,
        eventType,
        eventTimestamp: embed.timestamp
            ? new Date(embed.timestamp)
            : null
    };
}
