import { DefaultMacroParser, NAME_FIRST_BIOME_REGEX } from "./default-macro.parser";

/** J.Jaram reports "NAME Biome Started/Ended". */
export class JJaramParser extends DefaultMacroParser {
    constructor() {
        super("j.jaram", { biomeRegex: NAME_FIRST_BIOME_REGEX });
    }
}
