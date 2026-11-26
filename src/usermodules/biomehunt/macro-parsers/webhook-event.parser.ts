import { ComponentType } from "discord.js";
import { Logger } from "@/utils/logging";
import type { ParsedEvent } from "../types";
import { detectMacroParser } from "./macro-parser.registry";
import type { EmbedLike, ExtractionStep } from "./types";

const logger = new Logger("biomehunt.macro-parsers.webhook-event");

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

/**
 * What marks a merchant report. Narrow on purpose, since it counts as macro time: a settings dump
 * saying "Merchant: ON", or an account named after a merchant, must not match.
 */
const MERCHANT_ARRIVAL = /\b(?:mari|jester|rin)\s+has arrived\b/i;
const MERCHANT_TITLE = /\b(?:mari|jester|rin|merchant (?:detected|has arrived))\b/i;
const MERCHANT_FIELD = /^detected merchant\b/i;

function embedOf(message: WebhookMessageLike): EmbedLike | null {
    return message.embeds[0] ?? (message.components ? componentsToEmbedLike(message.components) : null);
}

/** The id of the macro with its own parser that sent the report, or `null` for any other. */
export function detectedMacro(message: WebhookMessageLike): string | null {
    const embed = embedOf(message);
    const id = embed ? detectMacroParser(embed.footer?.text).id : "unknown";
    return id === "unknown" ? null : id;
}

/** A merchant report: no biome in it, but proof that the macro is hunting and the bot understands it. */
export function isMerchantReport(message: WebhookMessageLike): boolean {
    const embed = embedOf(message);
    if (!embed) return false;
    const texts = [embed.title, embed.description, ...(embed.fields?.map((f) => f.value) ?? [])];
    return (
        MERCHANT_TITLE.test(embed.title ?? "") ||
        texts.some((text) => text && MERCHANT_ARRIVAL.test(text)) ||
        (embed.fields?.some((f) => f.name && MERCHANT_FIELD.test(f.name)) ?? false)
    );
}

export interface MessageInspection {
    /** What was parsed: the first embed, a ComponentsV2 body, or nothing readable. */
    input: "embed" | "components" | "none";
    parserId: string | null;
    footer: string | null;
    steps: ExtractionStep[];
    serverLink: string | null;
    merchant: boolean;
    event: ParsedEvent | null;
}

/** The one parse path: detection reads `event`, `/owner parse` shows the rest. */
export function inspectMessage(message: WebhookMessageLike): MessageInspection {
    const embed = embedOf(message);
    if (!embed) return { input: "none", parserId: null, footer: null, steps: [], serverLink: null, merchant: false, event: null };

    logger.verbose("Detecting macro type...");
    const parser = detectMacroParser(embed.footer?.text);
    logger.verbose(`Detected macro type: ${parser.id ?? "undefined?"}`);

    if (parser.id === "unknown") {
        logger.warn(`Webhook ${message.webhookId} has unknown macro type: ${embed.footer?.text}`);
    }

    const steps: ExtractionStep[] = [];
    const { biome, eventType } = parser.extractBiome(embed, steps);
    const serverLink = parser.extractServerLink(embed, message.components ? flattenActionRows(message.components) : undefined);

    return {
        input: message.embeds[0] ? "embed" : "components",
        parserId: parser.id,
        footer: embed.footer?.text ?? null,
        steps,
        serverLink,
        merchant: isMerchantReport(message),
        event: biome
            ? {
                  biome,
                  macroType: parser.id,
                  eventType,
                  eventTimestamp: embed.timestamp ? new Date(embed.timestamp) : (message.createdAt ?? null),
                  serverLink,
              }
            : null,
    };
}

export function parseEvent(message: WebhookMessageLike): ParsedEvent | null {
    return inspectMessage(message).event;
}
