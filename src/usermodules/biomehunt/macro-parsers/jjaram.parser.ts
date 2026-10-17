import { BIOME_WORDS_PATTERN, DefaultMacroParser } from "./default-macro.parser";

/** J.Jaram reports "NAME Biome Started/Ended" - the biome name comes before the anchor, not after. */
const JJARAM_BIOME_PATTERN = new RegExp(BIOME_WORDS_PATTERN + String.raw`\s+Biome\s+(?<event>Started|Ended)\b`, "i");

export class JJaramParser extends DefaultMacroParser {
    constructor() {
        super("j.jaram", { biomeRegex: JJARAM_BIOME_PATTERN });
    }
}
