import { DefaultMacroParser } from "./default-macro.parser";

/** FishSol Macro - the common format. It reports no "Ended", and reports the Normal biome. */
export class FishsolParser extends DefaultMacroParser {
    constructor() {
        super("fishsol");
    }
}
