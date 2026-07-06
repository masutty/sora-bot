import { DefaultMacroParser } from "./DefaultMacroParser";

/** EggSol Macro - currently follows the common format, override methods here if that changes. */
export class EggsolParser extends DefaultMacroParser {
    constructor() {
        super("eggsol");
    }
}
