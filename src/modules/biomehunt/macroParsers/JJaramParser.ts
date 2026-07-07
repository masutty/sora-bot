import { DefaultMacroParser } from "./DefaultMacroParser";

/** J.Jaram reports "NAME Biome Started/Ended" - the biome name comes before the anchor, not after. */
const JJARAM_BIOME_PATTERN =
    /(?<words>[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+)?)\s+Biome\s+(?<event>Started|Ended)\b/i;

export class JJaramParser extends DefaultMacroParser {
    constructor() {
        super("j.jaram", { biomeRegex: JJARAM_BIOME_PATTERN });
    }
}
