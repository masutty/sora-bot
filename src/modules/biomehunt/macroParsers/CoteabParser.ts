import { DefaultMacroParser } from "./DefaultMacroParser";

/** Coteab Macro - currently follows the common format, override methods here if that changes. */
export class CoteabParser extends DefaultMacroParser {
    constructor() {
        super("coteab");
    }
}
