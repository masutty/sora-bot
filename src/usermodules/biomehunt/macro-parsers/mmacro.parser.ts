import { DefaultMacroParser } from "./default-macro.parser";

/** MMacro - the common format. It has no footer: its name is the embed's author ("MMacro · Biome"). */
export class MmacroParser extends DefaultMacroParser {
    constructor() {
        super("mmacro");
    }
}
