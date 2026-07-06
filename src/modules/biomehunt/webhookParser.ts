import { Logger } from "@/utils/logging";
import { detectMacroParser, type EmbedLike } from "./macroParsers";
import type { ParsedEvent } from "./types";

const logger = new Logger("biomehunt.webhookParser");

export interface WebhookMessageLike {
    webhookId: string | null;
    embeds: ReadonlyArray<EmbedLike>;

    /** Some macros (e.g. Multiscope) attach the private server join link as a Link button instead of embed text. */
    components?: ReadonlyArray<unknown>;
}

export function parseEvent(message: WebhookMessageLike): ParsedEvent | null {
    const embed = message.embeds[0];
    if (!embed) return null;

    const parser = detectMacroParser(embed.footer?.text);
    if (parser.id === "unknown") {
        logger.warn(`Webhook ${message.webhookId} has unknown macro type: ${embed.footer?.text}`);
    }

    const { biome, eventType } = parser.extractBiome(embed);
    if (!biome) return null;

    return {
        biome,
        macroType: parser.id,
        eventType,
        eventTimestamp: embed.timestamp
            ? new Date(embed.timestamp)
            : null,
        serverLink: parser.extractServerLink(embed, message.components),
    };
}
