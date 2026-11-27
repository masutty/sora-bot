import { ComponentType } from "discord.js";
import { Logger } from "@/utils/logging";
import { isNormalBiome } from "../constants/biomes.constants";
import type { ParsedEvent } from "../types";
import { detectMacroParser } from "./macro-parser.registry";
import { readMerchant } from "./merchant.reader";
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

function embedOf(message: WebhookMessageLike): EmbedLike | null {
    return message.embeds[0] ?? (message.components ? componentsToEmbedLike(message.components) : null);
}

/** Where a macro names itself: the footer, the author, or both - so a macro moving its name keeps working. */
const signatureOf = (embed: EmbedLike) => [embed.footer?.text, embed.author?.name].filter(Boolean).join(" ");

/** The id of the macro with its own parser that sent the report, or `null` for any other. */
export function detectedMacro(message: WebhookMessageLike): string | null {
    const embed = embedOf(message);
    const id = embed ? detectMacroParser(signatureOf(embed)).id : "unknown";
    return id === "unknown" ? null : id;
}

/**
 * A report that is no find but shows the macro is hunting: it counts as macro time. A merchant one
 * carries no biome; a Normal one carries it, so a running timed biome ends.
 */
export type Checkpoint = Pick<ParsedEvent, "eventType"> & {
    kind: "merchant" | "normal";
    biome: string | null;
    /** The merchant clearly named in the report - only then is it recorded and forwarded. */
    merchant: string | null;
};

export interface MessageInspection {
    /** What was parsed: the first embed, a ComponentsV2 body, or nothing readable. */
    input: "embed" | "components" | "none";
    parserId: string | null;
    footer: string | null;
    author: string | null;
    steps: ExtractionStep[];
    serverLink: string | null;
    /** A find. Never set together with `checkpoint`. */
    event: ParsedEvent | null;
    checkpoint: Checkpoint | null;
}

/** The one parse path: detection reads `event` and `checkpoint`, `/owner parse` shows the rest. */
export function inspectMessage(message: WebhookMessageLike): MessageInspection {
    const embed = embedOf(message);
    if (!embed)
        return { input: "none", parserId: null, footer: null, author: null, steps: [], serverLink: null, event: null, checkpoint: null };

    logger.verbose("Detecting macro type...");
    const parser = detectMacroParser(signatureOf(embed));
    logger.verbose(`Detected macro type: ${parser.id ?? "undefined?"}`);

    if (parser.id === "unknown") {
        logger.warn(`Webhook ${message.webhookId} has unknown macro type: ${signatureOf(embed)}`);
    }

    const steps: ExtractionStep[] = [];
    const { biome, eventType } = parser.extractBiome(embed, steps);
    const serverLink = parser.extractServerLink(embed, message.components ? flattenActionRows(message.components) : undefined);

    const normal = biome !== null && isNormalBiome(biome);
    const merchant = readMerchant(embed);
    const checkpoint: Checkpoint | null =
        normal && eventType
            ? { kind: "normal", biome, eventType, merchant: null }
            : merchant
              ? { kind: "merchant", biome: null, eventType: null, merchant: merchant.name }
              : null;

    return {
        input: message.embeds[0] ? "embed" : "components",
        parserId: parser.id,
        footer: embed.footer?.text ?? null,
        author: embed.author?.name ?? null,
        steps,
        serverLink,
        checkpoint,
        event:
            biome && !normal
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
