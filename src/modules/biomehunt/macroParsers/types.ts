export interface EmbedLike {
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
}

export interface BiomeExtraction {
    biome: string | null;
    eventType: "started" | "ended" | null;
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

    abstract extractBiome(embed: EmbedLike): BiomeExtraction;
    abstract extractServerLink(embed: EmbedLike, components?: ReadonlyArray<unknown>): string | null;
}
