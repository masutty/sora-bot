import { DefaultMacroParser } from "./default-macro.parser";

/** Sora Minimal Macro - currently follows the common format, override methods here if that changes. */
export class SoraMinimalParser extends DefaultMacroParser {
    constructor() {
        super("sora-minimal");
    }
}
