import { ComponentType } from "discord.js";
import { Logger } from "@/utils/logging";
import { detectMacroParser, type EmbedLike } from "./macroParsers";
import type { ParsedEvent } from "./types";

const logger = new Logger("biomehunt.webhookParser");

export interface WebhookMessageLike {
    webhookId: string | null;
    embeds: ReadonlyArray<EmbedLike>;

    /** Some macros (e.g. Multiscope) attach the private server join link as a Link button instead of embed text. */
    components?: ReadonlyArray<unknown>;

    /** Used as a last-resort `eventTimestamp` for a ComponentsV2 macro (no per-embed timestamp to read there - see `componentsToEmbedLike`). */
    createdAt?: Date | null;
}

interface ComponentLike {
    type?: number;
    content?: string | null;
    url?: string | null;
    components?: ReadonlyArray<unknown>;
}

/** Recursively collects every TextDisplay's `content` under a ComponentsV2 tree (Container/Section nest arbitrarily deep). */
function collectTextDisplays(components: ReadonlyArray<unknown>): string[] {
    const texts: string[] = [];
    for (const raw of components) {
        const c = raw as ComponentLike;
        if (c.type === ComponentType.TextDisplay && c.content) texts.push(c.content);
        if (c.components) texts.push(...collectTextDisplays(c.components));
    }
    return texts;
}

/**
 * Recursively finds every ActionRow anywhere in a component tree - a no-op for a classic message
 * (its `components` are already just top-level ActionRows), and what actually locates a Link
 * button buried inside a ComponentsV2 Container/Section (see the SolRich sample: the private
 * server button sits at container -> action row, two levels deep). Returned rows are what
 * `MacroParser#extractServerLink`'s button fallback already expects: `{ components: [{ url }] }`.
 */
function flattenActionRows(components: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
    const rows: unknown[] = [];
    for (const raw of components) {
        const c = raw as ComponentLike;
        if (c.type === ComponentType.ActionRow) {
            rows.push(c);
        } else if (c.components) {
            rows.push(...flattenActionRows(c.components));
        }
    }
    return rows;
}

/**
 * Converts a ComponentsV2 message body into an `EmbedLike` so every existing `MacroParser`
 * (written against classic embeds) works unmodified against a Container-based macro too - no
 * per-macro ComponentsV2 parsing needed, just a `DefaultMacroParser` subclass like any other.
 * Each TextDisplay becomes its own `fields[].value` candidate (kept separate, not joined into one
 * blob, so the biome regex isn't confused by unrelated surrounding text); `footer.text` is the
 * concatenation of all of them, since `detectMacroParser` just needs the macro's name/id to show
 * up SOMEWHERE in it, not in any specific position.
 */
function componentsToEmbedLike(components: ReadonlyArray<unknown>): EmbedLike | null {
    const texts = collectTextDisplays(components);
    if (texts.length === 0) return null;

    return {
        footer: { text: texts.join("\n") },
        fields: texts.map((value) => ({ value })),
    };
}

export function parseEvent(message: WebhookMessageLike): ParsedEvent | null {
    const embed = message.embeds[0] ?? (message.components ? componentsToEmbedLike(message.components) : null);
    if (!embed) return null;

    logger.verbose("Detecting macro type...")
    const parser = detectMacroParser(embed.footer?.text);
    logger.verbose(`Detected macro type: ${parser.id ?? "undefined?"}`);

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
            : (message.createdAt ?? null),
        serverLink: parser.extractServerLink(embed, message.components ? flattenActionRows(message.components) : undefined),
    };
}
