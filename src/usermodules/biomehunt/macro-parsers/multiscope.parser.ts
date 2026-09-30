import { DefaultMacroParser } from "./default-macro.parser";

/** Multiscope Macro - currently follows the common format, override methods here if that changes. */
export class MultiscopeParser extends DefaultMacroParser {
    constructor() {
        super("multiscope");
    }
}
