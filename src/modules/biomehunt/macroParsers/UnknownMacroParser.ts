import { DefaultMacroParser } from "./DefaultMacroParser";

/** Fallback for a footer that doesn't match any known macro - still attempts the common format. */
export class UnknownMacroParser extends DefaultMacroParser {
    constructor() {
        super("unknown");
    }
}
