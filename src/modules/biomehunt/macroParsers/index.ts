import { CoteabParser } from "./CoteabParser";
import { DroidscopeParser } from "./DroidscopeParser";
import { EggsolParser } from "./EggsolParser";
import { MaxstellarParser } from "./MaxstellarParser";
import { MultiscopeParser } from "./MultiscopeParser";
import type { MacroParser } from "./types";
import { UnknownMacroParser } from "./UnknownMacroParser";

const KNOWN_PARSERS: MacroParser[] = [
    new CoteabParser(),
    new MultiscopeParser(),
    new EggsolParser(),
    new MaxstellarParser(),
    new DroidscopeParser(),
];

/** Picks the macro's parser class by matching its id against the webhook embed's footer text. */
export function detectMacroParser(footer?: string | null): MacroParser {
    if (footer) {
        const f = footer.toLowerCase();
        const found = KNOWN_PARSERS.find((parser) => f.includes(parser.id));
        if (found) return found;
    }
    return new UnknownMacroParser();
}

export { MacroParser, type BiomeExtraction, type EmbedLike } from "./types";
