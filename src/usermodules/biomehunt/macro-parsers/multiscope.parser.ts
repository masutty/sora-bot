import { DEFAULT_BIOME_REGEX, DefaultMacroParser, NAME_FIRST_BIOME_REGEX } from "./default-macro.parser";

/** Multiscope Macro - reports "NAME Biome Started/Ended"; the common order is still accepted. */
export class MultiscopeParser extends DefaultMacroParser {
    constructor() {
        super("multiscope", { biomeRegex: [DEFAULT_BIOME_REGEX, NAME_FIRST_BIOME_REGEX] });
    }
}
