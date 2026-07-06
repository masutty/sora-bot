import { DefaultMacroParser } from "./DefaultMacroParser";

/** Droidscope Macro - currently follows the common format, override methods here if that changes. */
export class DroidscopeParser extends DefaultMacroParser {
    constructor() {
        super("droidscope");
    }
}
