import type { ParsedEvent } from "./types";

export interface WebhookMessageLike {
    webhookId: string | null;
    embeds: ReadonlyArray<{
        title?: string | null;
        description?: string | null;
        footer?: { text?: string | null } | null;
        timestamp?: string | null;
    }>;
}

const BIOME_PATTERN = /Biome\s+(Started|Ended)\b[^A-Za-z0-9]*([A-Za-z0-9_]+)/i;

function stripMarkdown(text: string): string {
    return text.replace(/[#>*`]/g, " ");
}

export function parseEvent(message: WebhookMessageLike): ParsedEvent | null {
    if (!message.webhookId) return null;

    const embed = message.embeds[0];
    if (!embed) return null;

    const haystack = stripMarkdown(`${embed.title ?? ""}\n${embed.description ?? ""}`);
    const match = haystack.match(BIOME_PATTERN);
    if (!match) return null;

    return {
        biome: match[2].toUpperCase(),
        macroType: embed.footer?.text ?? null,
        eventTimestamp: embed.timestamp ? new Date(embed.timestamp) : null,
    };
}
