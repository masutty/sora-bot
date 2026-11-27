export interface EmbedLike {
    title?: string | null;
    description?: string | null;
    footer?: {
        text?: string | null;
    } | null;
    timestamp?: string | null;

    /** Some macros (e.g. MMacro) name themselves here instead of the footer. */
    author?: {
        name?: string | null;
    } | null;

    thumbnail?: {
        url?: string | null;
    } | null;

    fields?: ReadonlyArray<{
        name?: string | null;
        value?: string | null;
    }>;
}

export interface BiomeExtraction {
    biome: string | null;
    eventType: "started" | "ended" | null;
}

/** One text a parser looked at and what it got from it - what `/owner parse` shows. */
export interface ExtractionStep {
    source: string;
    text: string;
    outcome: "matched" | "unknown-biome" | "no-match";
    biome?: string;
    eventType?: "started" | "ended" | null;
}

/**
 * One subclass per macro (see the sibling files). Each macro can announce biomes in its own
 * way - different field, different phrasing, some don't announce "Ended" at all - so every
 * macro gets its own class to override independently instead of one shared regex trying to
 * handle every format at once. `DefaultMacroParser` holds today's known-common behavior;
 * override `extractBiome`/`extractServerLink` in a specific macro's class if its format
 * turns out to differ.
 */
export abstract class MacroParser {
    constructor(readonly id: string) {}

    /** Pass `steps` to have every text looked at recorded in it. */
    abstract extractBiome(embed: EmbedLike, steps?: ExtractionStep[]): BiomeExtraction;
    abstract extractServerLink(embed: EmbedLike, components?: ReadonlyArray<unknown>): string | null;
}
