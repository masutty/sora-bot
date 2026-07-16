import { DefaultMacroParser } from "./DefaultMacroParser";

/** Sora Minimal Macro - currently follows the common format, override methods here if that changes. */
export class SoraMinimalParser extends DefaultMacroParser {
    constructor() {
        super("sora-minimal");
    }
}
