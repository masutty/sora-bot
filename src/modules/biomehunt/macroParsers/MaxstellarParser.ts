import { DefaultMacroParser } from "./DefaultMacroParser";

/** Maxstellar Macro - currently follows the common format, override methods here if that changes. */
export class MaxstellarParser extends DefaultMacroParser {
    constructor() {
        super("maxstellar");
    }
}
